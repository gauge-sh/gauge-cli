case ":${PATH:-}:" in
  *:/gauge/session/npm/bin:*) ;;
  *) PATH="/gauge/session/npm/bin${PATH:+:$PATH}" ;;
esac
export PATH
