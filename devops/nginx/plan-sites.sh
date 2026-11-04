#!/bin/sh
# Edge config for every planner on the box, written at container start by the
# nginx image's entrypoint (mounted into /docker-entrypoint.d/ by
# compose.edge.yml).
#
# PLAN_SITES is a space-separated list of hostname=port:
#
#   PLAN_SITES="ubr.neuralpilot-dev.com=8080 osmos.neuralpilot-dev.com=8081"
#
# Each site gets
#   :80   /.well-known/acme-challenge/ from the certbot webroot, else -> https
#   :443  everything -> http://127.0.0.1:<port>, that planner's plan-ui, which
#         serves the bundles and passes /api/ on to its own plan-api
#
# A site with no certificate yet gets only the :80 block, answering 503 outside
# the ACME path. That is what lets a new planner's certificate be issued over the
# webroot while the edge keeps serving the others: an `ssl_certificate` that
# does not exist fails the whole config, not just that site. Restart the edge
# once the certificate is there.
#
# The upstream is a literal address, so nginx never resolves anything at boot: a
# planner that is down is a 502 for its hostname alone.

set -eu

conf=/etc/nginx/conf.d/plan-sites.conf
# The image's own localhost server would otherwise be the :80 default.
rm -f /etc/nginx/conf.d/default.conf

# Host network: only listen on IPv6 where the host has it, or the bind fails.
v6=''
[ -f /proc/net/if_inet6 ] && v6=1

listen() { # port [ssl]
    echo "    listen $1${2:+ $2};"
    [ -n "$v6" ] && echo "    listen [::]:$1${2:+ $2};"
    return 0
}

: > "$conf"
for site in $PLAN_SITES; do
    host=${site%%=*}
    port=${site#*=}
    case "$port" in
        ''|*[!0-9]*) echo "plan-sites: '$site' is not hostname=port" >&2; exit 1 ;;
    esac
    [ "$host" != "$site" ] && [ -n "$host" ] || { echo "plan-sites: '$site' is not hostname=port" >&2; exit 1; }

    cert=/etc/letsencrypt/live/$host
    if [ -f "$cert/fullchain.pem" ] && [ -f "$cert/privkey.pem" ]; then
        tls=1
        fallback='return 301 https://$host$request_uri;'
        echo "plan-sites: $host -> 127.0.0.1:$port"
    else
        tls=''
        fallback='return 503 "no certificate yet\n";'
        echo "plan-sites: $host -> 127.0.0.1:$port: NO CERTIFICATE at $cert, serving ACME on :80 only" >&2
    fi

    {
        echo "server {"
        listen 80
        echo "    server_name $host;"
        echo "    location /.well-known/acme-challenge/ { root /var/www/certbot; }"
        printf '    location / { %s }\n' "$fallback"
        echo "}"
        if [ -n "$tls" ]; then
            cat <<EOF
server {
$(listen 443 ssl)
    http2 on;
    server_name $host;

    ssl_certificate     $cert/fullchain.pem;
    ssl_certificate_key $cert/privkey.pem;

    # Answered by the edge itself, so it stays true while a planner rebuilds.
    location = /healthz {
        access_log off;
        add_header Content-Type text/plain;
        return 200 "ok\n";
    }

    # No caching, ever: a cached /api/ GET would hand somebody a plan that has
    # already moved on.
    location / {
        proxy_pass         http://127.0.0.1:$port;
        proxy_http_version 1.1;
        proxy_set_header   Host              \$host;
        proxy_set_header   X-Real-IP         \$remote_addr;
        proxy_set_header   X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
        proxy_cache        off;
    }
}
EOF
        fi
    } >> "$conf"
done
