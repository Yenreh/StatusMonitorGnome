# StatusMonitorGnome

GNOME Shell extension that shows CPU, memory, storage and GPU usage,
temperature and power draw in the top bar, with the detail in a drop down menu.

Everything is read from `/proc` and `sysfs`, so it works on Intel and AMD
processors and on AMD, Intel and NVIDIA graphics without any helper daemon.
Sensors the machine does not expose are hidden instead of shown as N/A.

Developed on GNOME Shell 48 (Wayland) with an Intel CPU and an NVIDIA GPU.

## Features

- Panel: one group of values per device, in CPU, memory, GPU, storage order, for
  example `CPU 12% 38°C 21 W`. Every value can be shown or hidden independently.
  Each value keeps a fixed width, so the top bar does not shift as numbers change.
- Colors: each value turns yellow and red at its own warning and critical
  thresholds, in the panel and the menu, switched on one by one in the Colors
  page of the preferences. Temperatures are colored by default, usage is not.
- Menu: usage, temperature, power and frequency per device, memory and swap in
  GiB, VRAM per GPU, and used space, throughput and per drive temperature for
  storage, with level bars that follow the color thresholds of their value.
- Each group is marked with its device icon, a text prefix (`CPU`, `RAM`,
  `DISK`, `GPU`) or nothing, as configured.
- The monitored filesystem is configurable, `/` by default. The panel shows the
  temperature of the hottest drive; the menu lists every drive by model.
- Sensors the machine does not expose are hidden rather than shown as N/A.
- Multiple GPUs get one section each, whatever the vendor mix.

## Requirements

| Requirement | Needed for | If missing |
| --- | --- | --- |
| GNOME Shell 45 to 48 | Everything | The extension does not load |
| `nvidia-smi` in PATH | NVIDIA cards | The card is hidden, others still shown |
| Readable energy counter | CPU power in watts | CPU power row and panel value are hidden |

Nothing else is required. CPU usage, temperatures, frequency, memory, disk
space, disk activity and non NVIDIA graphics are read straight from `/proc` and
`sysfs`, so no `lm-sensors` install and no helper daemon is involved.

Each driver publishes a different subset of the GPU values:

| Driver | Usage | Memory | Temperature | Power | Frequency |
| --- | --- | --- | --- | --- | --- |
| NVIDIA (`nvidia-smi`) | yes | yes | yes | yes | yes |
| `amdgpu` | yes | yes | yes | yes | yes |
| `i915`, `xe` | no | no | if the card has a sensor | from the energy counter | yes |
| `nouveau`, `radeon` | no | no | yes | no | no |

`lm-sensors` is still handy to see what your machine exposes at all:

    sensors

## Install

Clone the repository, then:

    ./install.sh

It compiles the settings schema and copies the extension into
`~/.local/share/gnome-shell/extensions/`. Log out and log back in, since GNOME
Shell cannot be restarted on Wayland, and enable it:

    gnome-extensions enable statusmonitorgnome@yenreh.github.com

Preferences:

    gnome-extensions prefs statusmonitorgnome@yenreh.github.com

To uninstall, disable it and remove the directory:

    gnome-extensions disable statusmonitorgnome@yenreh.github.com
    rm -rf ~/.local/share/gnome-shell/extensions/statusmonitorgnome@yenreh.github.com

## CPU power in watts

The value comes from the RAPL energy counter, exposed by the kernel powercap
driver on Intel and on AMD, which the kernel restricts to root. Grant read
access once with:

    ./enable-cpu-power.sh

Run it as your normal user, it calls `sudo` where it needs to. It installs a
udev rule that gives every package level `energy_uj` mode `0440` and your
primary group. The finer core and dram counters stay root only, and nothing becomes
writable, so power limits cannot be changed through it. Undo it with:

    ./disable-cpu-power.sh

This is optional. Without it every other value still works, GPU watts included.
Chips that publish the CPU power directly, `zenpower` for example, are used as
they are and need no rule.

The counter is restricted because a high resolution energy reading is a power
side channel: sampled fast enough it leaks information about what other
processes compute (CVE-2020-8694, PLATYPUS). The strongest published attacks
extract keys from SGX enclaves, which consumer CPUs from the 11th generation on
no longer have. What remains is that code already running as your user gains one
more way to infer activity it cannot read directly, such as kernel or virtual
machine work. On a single user machine where you control what runs, the added
exposure is small, but it is not zero. Decide accordingly.

## Settings

| Key | Default | Meaning |
| --- | --- | --- |
| `refresh-interval` | `2` | Seconds between sensor readings |
| `prefix-style` | `icon` | Group marker: `icon`, `text` or `none` |
| `panel-box` | `right` | Top bar area: `left`, `center` or `right` |
| `panel-position` | `1` | Order within the area, lower goes further left |
| `show-cpu-usage` | `true` | CPU usage in the panel |
| `show-cpu-temp` | `true` | CPU package temperature in the panel |
| `show-cpu-power` | `true` | CPU package watts in the panel |
| `show-memory-usage` | `true` | Used memory percentage in the panel |
| `show-disk-usage` | `true` | Used space of the monitored mount point |
| `show-disk-temp` | `true` | Temperature of the hottest drive |
| `show-disk-io` | `false` | Combined read and write throughput |
| `disk-mount` | `/` | Filesystem whose used space is reported |
| `show-gpu-usage` | `true` | GPU usage in the panel |
| `show-gpu-vram` | `false` | Used video memory in the panel |
| `gpu-vram-unit` | `gib` | Video memory in the panel: `gib` or `percent` |
| `show-gpu-temp` | `true` | GPU temperature in the panel |
| `show-gpu-power` | `true` | GPU watts in the panel |

Colors, one switch and one pair of thresholds per value. `color-X` turns
coloring on, `X-warn` and `X-crit` set where the value turns yellow and red:

| Value `X` | Colored by default | Warning, critical |
| --- | --- | --- |
| `cpu-usage` | no | 75%, 90% |
| `cpu-temp` | yes | 80°C, 90°C |
| `memory-usage` (swap too) | no | 75%, 90% |
| `gpu-usage` | no | 75%, 90% |
| `gpu-vram` | no | 75%, 90% of the total |
| `gpu-temp` | yes | 80°C, 90°C |
| `disk-usage` | no | 80%, 95% |
| `disk-temp` | yes | 55°C, 65°C |

## Sources

| Value | Source |
| --- | --- |
| CPU usage | `/proc/stat` |
| CPU temperature | `hwmon` package sensor (`coretemp`, `k10temp`, `zenpower`, ...), then any package label, then a `thermal_zone` |
| CPU power | `/sys/class/powercap/*:N/energy_uj` delta, or `hwmon` `power1_*` |
| CPU frequency | `cpufreq/scaling_cur_freq`, averaged over the cores |
| Memory, swap | `/proc/meminfo` |
| Disk used space | `statvfs` of the configured mount point |
| Disk temperature | `hwmon` `nvme` Composite sensor, or `drivetemp` for SATA |
| Disk activity | `/proc/diskstats` sector counters |
| GPU, NVIDIA | `nvidia-smi --query-gpu` |
| GPU, other | `/sys/class/drm/cardN` and its `hwmon` chip |
| GPU model name | `/usr/share/hwdata/pci.ids`, or `/usr/share/misc/pci.ids` |

Everything except NVIDIA cards is read directly from the kernel, so only they
spawn a process.

## Icons

The four icons in `icons/` ship with the extension, because no icon theme
provides a CPU or a memory one. They are drawn in the Adwaita symbolic grammar:
a solid shape on the 16x16 grid with 2 pixel cutouts. The `-symbolic.svg`
suffix is what makes GTK recolour them, so they follow the panel foreground
colour in light and dark themes.

| Icon | Device |
| --- | --- |
| `cpu-symbolic.svg` | Chip with pins on the four sides |
| `memory-symbolic.svg` | Memory module with contact teeth |
| `ssd-symbolic.svg` | Drive body with a status block |
| `gpu-symbolic.svg` | Graphics card with fan and PCIe teeth |

## Development

Reinstall after a change and log out and back in: GNOME Shell imports an
extension module once per session, so `reloadExtension` does not pick up edited
code.

    ./install.sh

Errors go to the shell log:

    journalctl -f -o cat /usr/bin/gnome-shell

## License

MIT, see [LICENSE](LICENSE).
