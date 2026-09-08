#!/usr/bin/env bash
# Allow reading the Intel RAPL package energy counter without root, which is
# what the CPU power value is derived from. Run it as your normal user, it
# calls sudo only where it needs to. Optional: without it the extension simply
# hides the CPU power row.
#
# The counter is root only because a high resolution energy reading is a power
# side channel: sampling it fast enough leaks information about what other
# processes compute (CVE-2020-8694). This rule exposes only the package level
# counter, and only to one user's group, never to every account, and never for
# writing. Undo it with disable-cpu-power.sh.
set -euo pipefail

RULE="/etc/udev/rules.d/99-statusmonitorgnome-rapl.rules"
COUNTER="/sys/class/powercap/intel-rapl:0/energy_uj"

# Access is granted to a real account, so running the script under sudo must
# still resolve the user behind it instead of granting it to root.
TARGET_USER="${SUDO_USER:-$(id -un)}"
if [ "$TARGET_USER" = "root" ]; then
    echo "Run this as your normal user, not as root: ./enable-cpu-power.sh" >&2
    exit 1
fi
TARGET_GROUP="$(id -gn "$TARGET_USER")"

# intel-rapl:? matches the package domains only. The finer core and dram
# counters, intel-rapl:0:0 and below, stay root only. Both add and change are
# matched: add fires at boot, change is what a later udevadm trigger emits.
sudo tee "$RULE" >/dev/null <<RULE_EOF
SUBSYSTEM=="powercap", ACTION=="add|change", KERNEL=="intel-rapl:?", RUN+="/bin/chgrp $TARGET_GROUP /sys%p/energy_uj", RUN+="/bin/chmod 0440 /sys%p/energy_uj"
RULE_EOF

sudo udevadm control --reload-rules
sudo udevadm trigger --subsystem-match=powercap --action=add
sudo udevadm settle

# Checking with test -r would pass just because this runs under sudo, so the
# owner and mode are compared instead.
read -r group mode <<<"$(stat -c '%G %a' "$COUNTER")"
if [ "$group" = "$TARGET_GROUP" ] && [ "$mode" = "440" ]; then
    echo "CPU power reading enabled for $TARGET_USER (group $TARGET_GROUP)"
else
    echo "Rule installed, but the counter did not change. Reboot and check again." >&2
fi
ls -l "$COUNTER"
