# StatusMonitorGnome

GNOME Shell extension that shows CPU, memory, storage and GPU usage,
temperature and power draw in the top bar, with the detail in a drop down menu.

Tested on GNOME Shell 48 (Wayland), with an Intel CPU and an NVIDIA GPU.

## Features

- Panel: one group of values per device, for example `CPU 12% 38°C 21 W`. Every
  value can be shown or hidden independently.
- Menu: usage, temperature, power and frequency per device, memory and swap in
  GiB, VRAM per GPU, and used space, throughput and per drive temperature for
  storage, with level bars that turn yellow at 75% and red at 90%.
- Each group is marked with its device icon, a text prefix (`CPU`, `RAM`, `SSD`,
  `GPU`) or nothing, as configured.
- The monitored filesystem is configurable, `/` by default. The panel shows the
  temperature of the hottest drive; the menu lists every drive by model.
- Sensors the machine does not expose are hidden rather than shown as N/A.
- Multiple GPUs get one section each.

## Requirements

| Requirement | Needed for | If missing |
| --- | --- | --- |
| GNOME Shell 45 to 48 | Everything | The extension does not load |
| `nvidia-smi` in PATH | GPU section | GPU section and its panel values are hidden |
| Readable RAPL counter | CPU power in watts | CPU power row and panel value are hidden |

Nothing else is required. CPU usage, temperatures, frequency, memory, disk
space and disk activity are read straight from `/proc` and `sysfs`, so no
`lm-sensors` install and no helper daemon is involved. AMD and Intel GPUs are
not supported: only NVIDIA exposes usage, temperature and power draw through a
single supported command.

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

The value comes from the Intel RAPL energy counter, which the kernel restricts
to root. Grant read access once with:

    ./enable-cpu-power.sh

Run it as your normal user, it calls `sudo` where it needs to. It installs a
udev rule that gives the package level `energy_uj` mode `0440` and your primary
group. The finer core and dram counters stay root only, and nothing becomes
writable, so power limits cannot be changed through it. Undo it with:

    ./disable-cpu-power.sh

This is optional. Without it every other value still works, GPU watts included.

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
| `show-cpu-usage` | `true` | CPU usage in the panel |
| `show-cpu-temp` | `true` | CPU package temperature in the panel |
| `show-cpu-power` | `true` | CPU package watts in the panel |
| `show-memory-usage` | `true` | Used memory percentage in the panel |
| `show-disk-usage` | `true` | Used space of the monitored mount point |
| `show-disk-temp` | `true` | Temperature of the hottest drive |
| `show-disk-io` | `false` | Combined read and write throughput |
| `disk-mount` | `/` | Filesystem whose used space is reported |
| `show-gpu-usage` | `true` | GPU usage in the panel |
| `show-gpu-temp` | `true` | GPU temperature in the panel |
| `show-gpu-power` | `true` | GPU watts in the panel |

## Sources

| Value | Source |
| --- | --- |
| CPU usage | `/proc/stat` |
| CPU temperature | `hwmon` package sensor (`coretemp`, `k10temp`, `zenpower`, ...) |
| CPU power | `/sys/class/powercap/intel-rapl:N/energy_uj` delta |
| CPU frequency | `cpufreq/scaling_cur_freq`, averaged over the cores |
| Memory, swap | `/proc/meminfo` |
| Disk used space | `statvfs` of the configured mount point |
| Disk temperature | `hwmon` `nvme` Composite sensor, or `drivetemp` for SATA |
| Disk activity | `/proc/diskstats` sector counters |
| GPU | `nvidia-smi --query-gpu` |

Everything except the GPU is read directly from the kernel, so only the GPU
values spawn a process.

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
