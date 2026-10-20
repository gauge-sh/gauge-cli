#!/bin/sh
set -eu
if [ "$1" = clone ]; then
  case "$4" in *fail/prepare*) exit 42 ;; esac
  /usr/bin/git init -q -b master "$5"
  cd "$5"
  /usr/bin/git -c user.email=fixture@example.com -c user.name=Fixture commit -q --allow-empty -m initial
else
  exec /usr/bin/git "$@"
fi
