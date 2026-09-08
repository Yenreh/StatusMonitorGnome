#!/usr/bin/env bash
# Undo enable-cpu-power.sh: the RAPL energy counter goes back to root only.
set -euo pipefail

RULE="/etc/udev/rules.d/99-statusmonitorgnome-rapl.rules"

sudo rm -f "$RULE"
sudo udevadm control --reload-rules

for counter in /sys/class/powercap/intel-rapl*:[0-9]/energy_uj; do
    [ -e "$counter" ] || continue
    sudo chmod 0400 "$counter"
    ls -l "$counter"
done

echo "CPU power reading disabled"
