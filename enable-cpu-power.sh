#!/usr/bin/env bash
# Allow reading the RAPL package energy counter without root, which is what
# the CPU power value is derived from. The counter exists on Intel and on AMD,
# both behind the powercap driver named intel-rapl. Run it as your normal user, it
# calls sudo only where it needs to. Optional: without it the extension simply
# hides the CPU power row.
#
# The counter is root only because a high resolution energy reading is a power
# side channel: sampling it fast enough leaks information about what other
# processes compute (CVE-2020-8694). This rule exposes only the package level
# counters, and only to one user's group, never to every account, and never for
# writing. Undo it with disable-cpu-power.sh.
set -euo pipefail

RULE="/etc/udev/rules.d/99-statusmonitorgnome-rapl.rules"

# Access is granted to a real account, so running the script under sudo must
# still resolve the user behind it instead of granting it to root.
TARGET_USER="${SUDO_USER:-$(id -un)}"
if [ "$TARGET_USER" = "root" ]; then
    echo "Run this as your normal user, not as root: ./enable-cpu-power.sh" >&2
    exit 1
fi
TARGET_GROUP="$(id -gn "$TARGET_USER")"

# The powercap driver is named intel-rapl on Intel and on AMD, and
# intel-rapl-mmio on boards exposing the memory mapped interface. The single
# ? matches the package domains only: the finer core and dram counters,
# intel-rapl:0:0 and below, stay root only. Both add and change are matched:
# add fires at boot, change is what a later udevadm trigger emits.
sudo tee "$RULE" >/dev/null <<RULE_EOF
SUBSYSTEM=="powercap", ACTION=="add|change", KERNEL=="intel-rapl:?", RUN+="/bin/chgrp $TARGET_GROUP /sys%p/energy_uj", RUN+="/bin/chmod 0440 /sys%p/energy_uj"
SUBSYSTEM=="powercap", ACTION=="add|change", KERNEL=="intel-rapl-mmio:?", RUN+="/bin/chgrp $TARGET_GROUP /sys%p/energy_uj", RUN+="/bin/chmod 0440 /sys%p/energy_uj"
RULE_EOF

sudo udevadm control --reload-rules
sudo udevadm trigger --subsystem-match=powercap --action=add
sudo udevadm settle

# Checking with test -r would pass just because this runs under sudo, so the
# owner and mode are compared instead, on every package counter found.
granted=0
for counter in /sys/class/powercap/intel-rapl*:[0-9]/energy_uj; do
    [ -e "$counter" ] || continue
    read -r group mode <<<"$(stat -c '%G %a' "$counter")"
    if [ "$group" = "$TARGET_GROUP" ] && [ "$mode" = "440" ]; then
        granted=$((granted + 1))
    fi
    ls -l "$counter"
done

if [ "$granted" -gt 0 ]; then
    echo "CPU power reading enabled for $TARGET_USER (group $TARGET_GROUP)"
else
    echo "No package energy counter changed. This machine may not expose one." >&2
fi
