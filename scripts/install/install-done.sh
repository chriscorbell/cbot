# ---------------------------------------------------------------- done

# The address this machine reaches the network from: its LAN address, or a server's public one.
lan_address() {
  local ip
  ip="$(ip -4 route get 1.1.1.1 2>/dev/null | grep -o 'src [0-9.]*' | cut -d' ' -f2)"
  [ -n "$ip" ] || ip="$(hostname -I 2>/dev/null | awk '{ print $1 }')"
  echo "${ip:-$(hostname)}"
}

private_address() {
  case "$1" in
    10.* | 192.168.* | 172.1[6-9].* | 172.2[0-9].* | 172.3[01].* | 100.6[4-9].* | 100.[7-9][0-9].* | 100.1[01][0-9].* | 100.12[0-7].*) return 0 ;;
    *) return 1 ;;
  esac
}

# The HTTPS address Tailscale Serve gives Dispatch, once someone has set that up.
tailscale_url() {
  local status
  command -v tailscale >/dev/null || return 0
  status="$(tailscale serve status 2>/dev/null)" || return 0
  case "$status" in *"127.0.0.1:$PORT"*) grep -o 'https://[^ ]*' <<<"$status" | head -1 ;; esac
}

finish() {
  local url address listening lan=false scheme=http code='' setup=''
  if $up_to_date; then
    printf '\n%s%s Dispatch is up to date%s %s(%s)%s\n\n' "$G$B" "$OK" "$R" "$D" "$commit" "$R"
  else
    printf '\n%s%s Dispatch is running%s %s(%s)%s\n\n' "$G$B" "$OK" "$R" "$D" "$commit" "$R"
  fi
  # An install can keep the server to 127.0.0.1 (HOST in /etc/dispatch/env), or to plain HTTP (HTTPS).
  listening="$(ss -Hltn "sport = :$PORT" | awk '{ print $4 }')"
  case "$listening" in '' | 127.0.0.1:*) ;; *) lan=true ;; esac
  curl -fsk --max-time 5 -o /dev/null "https://127.0.0.1:$PORT/api/health" && scheme=https
  url="$(tailscale_url || true)"
  url="${url%/}"
  address="$(lan_address)"
  # Until the account exists, making it takes the setup code (server/src/lib/auth.ts), which the
  # address carries for the web app to fill in.
  if curl -fsS --max-time 5 "http://127.0.0.1:$PORT/api/auth/me" 2>/dev/null | grep -q '"needsAccount":true'; then
    code="$(cat /var/lib/dispatch/setup-code 2>/dev/null || true)"
    setup="${code:+/#setup=$code}"
  fi
  if $lan; then
    info "Open $B$scheme://$address:$PORT$setup$R"
    [ -z "$url" ] || info "or $B$url$setup$R from anywhere on your tailnet"
    if [ "$scheme" = https ]; then
      info "The browser warns that the connection isn't private, because Dispatch signs its own certificate."
      info "Continue past it once per device, or install the certificate from Settings > General."
    fi
  elif [ -n "$url" ]; then
    info "Open $B$url$setup$R"
  else
    info "Dispatch listens on this machine only (HOST in /etc/dispatch/env). Reach it with"
    info "  $B""ssh -N -L $PORT:127.0.0.1:$PORT ${SUDO_USER:-root}@$address$R"
    info "then open $B""http://127.0.0.1:$PORT$setup$R"
  fi
  if [ -n "$code" ]; then
    info "Make your account there. The link carries its one-time setup code, $B$code$R; without it nobody can."
  fi
  if $lan && ! private_address "$address"; then
    warn "$address is a public address, so Dispatch is open to the internet. Block port $PORT in a firewall and reach Dispatch through Tailscale instead."
  elif $lan && command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q '^Status: active'; then
    warn "The firewall (ufw) is on. Let the local network reach Dispatch with: ufw allow $PORT/tcp"
  fi
  echo
  if [ -z "$url" ] && [ "$scheme" = http ]; then
    note "Voice calls need HTTPS, since browsers allow the microphone only there. Set HTTPS=1 in"
    note "/etc/dispatch/env, or put Tailscale on this machine and run:"
    note "  tailscale serve --bg --https=443 http://127.0.0.1:$PORT"
    echo
  fi
  note "Logs: journalctl -u dispatch -f"
  note "Settings: /etc/dispatch/env, then systemctl restart dispatch"
  note "Update: Settings > General in Dispatch, or run the installer again"
}
