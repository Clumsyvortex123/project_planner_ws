import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import bundled from '../../planner.config.json'
import { CONFIG, SETTINGS, applyConfig, buildModel } from './model.js'
import { Conflict, fetchConfig, revertConfig, saveConfig } from './api.js'

// Loads the one document everything is built from, installs it into the model,
// and keeps it current. The server's copy wins; the copy bundled at build time
// is only for running without a server. When the document changes — someone
// saved it in Settings, or edited planner.config.json on disk — the model is
// swapped and `rev` moves on, which remounts the app on the new model.

const Ctx = createContext(null)

function install(raw) {
  const { warnings } = applyConfig(raw)
  return warnings
}

export function ConfigProvider({ children }) {
  const [state, setState] = useState({ status: 'loading', rev: 0, source: null, version: null, errors: [], warnings: [], notice: '' })
  const ref = useRef(state)
  ref.current = state

  // Adopt a server answer if it is new and usable; report it if it is not.
  const adopt = useCallback((doc, notice) => {
    if (!doc) return
    if (doc.version === ref.current.version && ref.current.status === 'ready') return
    try {
      const warnings = install(doc.config)
      setState((s) => ({
        ...s,
        status: 'ready',
        rev: s.rev + 1,
        source: doc.source,
        version: doc.version,
        updatedAt: doc.updatedAt,
        errors: [],
        warnings,
        notice: s.status === 'ready' ? notice : '',
      }))
    } catch (err) {
      // A broken document on the server must not take the app down: keep what
      // is running (or the bundled copy at boot) and say what is wrong.
      setState((s) => {
        if (s.status !== 'ready') install(bundled)
        return {
          ...s,
          status: 'ready',
          rev: s.status === 'ready' ? s.rev : s.rev + 1,
          source: s.status === 'ready' ? s.source : 'bundled',
          version: doc.version,
          errors: err.errors || [err.message],
        }
      })
    }
  }, [])

  useEffect(() => {
    fetchConfig()
      .then((doc) => {
        if (doc) return adopt(doc)
        throw new Error('no config on the server')
      })
      .catch(() => {
        const warnings = install(bundled)
        setState((s) => ({ ...s, status: 'ready', rev: s.rev + 1, source: 'bundled', warnings }))
      })
  }, [adopt])

  useEffect(() => {
    if (state.status !== 'ready') return undefined
    const id = setInterval(() => {
      fetchConfig()
        .then((doc) => adopt(doc, 'The configuration changed — the board has been rebuilt from it.'))
        .catch(() => {})
    }, SETTINGS.pollMs || 8000)
    return () => clearInterval(id)
  }, [state.status, adopt])

  const value = {
    ...state,
    raw: CONFIG,
    validate: (raw) => buildModel(raw),
    dismiss: () => setState((s) => ({ ...s, notice: '' })),
    /** Save an edited document for everyone. Throws a Conflict if it moved underneath. */
    save: async (raw) => {
      const { model, errors } = buildModel(raw)
      if (!model) throw Object.assign(new Error('the config has problems'), { errors })
      try {
        const res = await saveConfig({ baseVersion: ref.current.version, config: raw })
        adopt({ ...res, config: raw }, 'Configuration saved for everyone.')
      } catch (err) {
        if (err instanceof Conflict) adopt(err.current, 'Someone else changed the configuration first — showing theirs.')
        throw err
      }
    },
    revert: async () => {
      const doc = await revertConfig()
      if (doc?.config) adopt(doc, 'Back to planner.config.json on disk.')
    },
  }

  if (state.status === 'loading') return <div className="boot muted">Loading the plan…</div>
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useConfig() {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useConfig must be used inside <ConfigProvider>')
  return ctx
}
