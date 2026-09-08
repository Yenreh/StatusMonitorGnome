#!/usr/bin/env bash
# Undo enable-cpu-power.sh: the RAPL energy counter goes back to root only.
set -euo pipefail

RULE="/etc/udev/rules.d/99-statusmonitorgnome-rapl.rules"

sudo rm -f "$RULE"
sudo udevadm control --reload-rules
sudo chmod 0400 /sys/class/powercap/intel-rapl:*/energy_uj

echo "CPU power reading disabled"
ls -l /sys/class/powercap/intel-rapl:0/energy_uj
