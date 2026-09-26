import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

// Must match the track width in stylesheet.css, the fill is sized in pixels.
const BAR_WIDTH = 90;

// Widest text each kind of panel value takes in normal use. Digits are
// tabular, so any digit stands for all of them.
const WIDTH_PERCENT = '100%';
const WIDTH_TEMP = '00°C';
const WIDTH_WATTS = '000 W';
const WIDTH_GIB = '00.0 GiB';
const WIDTH_RATE = '000.0 MiB/s';

const KIB = 1024;
const MIB = 1024 * 1024;
const GIB = 1024 * 1024 * 1024;

// Seconds between attempts to find the RAPL counters while they stay
// unreadable, so installing the udev rule takes effect without a relogin.
const RAPL_RETRY = 15;

// Block devices, without their partitions, as named in /proc/diskstats.
const DISK_DEVICE = /^(nvme\d+n\d+|sd[a-z]+|vd[a-z]+|xvd[a-z]+|hd[a-z]+|mmcblk\d+)$/;

// Top level powercap zones, such as intel-rapl:0. The finer domains below
// them, intel-rapl:0:0, are excluded so their watts are not counted twice.
const POWERCAP_ZONE = /^[\w.-]+:\d+$/;

// hwmon chips reporting a CPU package temperature, in preference order.
const CPU_TEMP_CHIPS = [
    'coretemp',
    'k10temp',
    'zenpower',
    'k8temp',
    'via_cputemp',
    'cpu_thermal',
    'soc_thermal',
    'acpitz',
];

// Thermal zone types that stand for the CPU, used when no hwmon chip matches.
const CPU_THERMAL_ZONE = /^(x86_pkg_temp|cpu[-_]?thermal|soc[-_]?thermal|cpu\d*)$/i;

// PCI vendors of graphics cards, to name a card when the id database is absent.
const PCI_VENDORS = new Map([
    ['1002', 'AMD'],
    ['1022', 'AMD'],
    ['10de', 'NVIDIA'],
    ['8086', 'Intel'],
    ['1af4', 'Virtio'],
    ['15ad', 'VMware'],
]);

// Where distributions ship the PCI id database that names a card.
const PCI_IDS_PATHS = ['/usr/share/hwdata/pci.ids', '/usr/share/misc/pci.ids'];

// Fields asked to nvidia-smi, in the order they are parsed.
const NVIDIA_QUERY = [
    'name',
    'utilization.gpu',
    'temperature.gpu',
    'memory.used',
    'memory.total',
    'power.draw',
    'power.limit',
    'clocks.sm',
].join(',');

function readFile(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        return ok ? new TextDecoder().decode(bytes) : null;
    } catch {
        return null;
    }
}

function readNumber(path) {
    const text = readFile(path);
    if (text === null)
        return null;
    const value = Number(text.trim());
    return Number.isFinite(value) ? value : null;
}

function listDir(path) {
    const names = [];
    try {
        const iter = Gio.File.new_for_path(path).enumerate_children(
            'standard::name', Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = iter.next_file(null)) !== null)
            names.push(info.get_name());
    } catch {
        // Missing directory: the sensor simply does not exist here.
    }
    return names;
}

function runCommand(argv) {
    return new Promise((resolve, reject) => {
        let proc;
        try {
            proc = Gio.Subprocess.new(argv,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        } catch (e) {
            reject(e);
            return;
        }
        proc.communicate_utf8_async(null, null, (obj, res) => {
            try {
                const [, stdout, stderr] = obj.communicate_utf8_finish(res);
                if (obj.get_successful())
                    resolve(stdout ?? '');
                else
                    reject(new Error((stderr || stdout || '').trim() || _('Command failed')));
            } catch (e) {
                reject(e);
            }
        });
    });
}

// Every hwmon chip as {name, dir}. One pass, since several monitors look for
// their own chip in the same list.
function hwmonChips() {
    const chips = [];
    for (const entry of listDir('/sys/class/hwmon')) {
        const dir = `/sys/class/hwmon/${entry}`;
        const name = readFile(`${dir}/name`)?.trim();
        if (name)
            chips.push({name, dir});
    }
    return chips;
}

// Temperature input of a chip, preferring the one labelled as the package.
function chipTempPath(dir, labelled = /package|tctl|tdie/i) {
    const inputs = listDir(dir).filter(f => /^temp\d+_input$/.test(f)).sort();
    for (const input of inputs) {
        const label = readFile(`${dir}/${input.replace('_input', '_label')}`)?.trim() ?? '';
        if (labelled.test(label))
            return `${dir}/${input}`;
    }
    return null;
}

// Model name of a PCI device from the system id database, so a card read from
// sysfs gets the same kind of title nvidia-smi returns. Cards are enumerated
// once, and the answer is cached, so the database is parsed at most once.
const pciNameCache = new Map();

function pciDeviceName(vendorId, deviceId) {
    if (!vendorId || !deviceId)
        return null;

    const key = `${vendorId}:${deviceId}`;
    if (pciNameCache.has(key))
        return pciNameCache.get(key);

    const text = PCI_IDS_PATHS.map(readFile).find(value => value !== null) ?? '';
    let name = null;
    let inVendor = false;
    for (const line of text.split('\n')) {
        if (line.startsWith('#'))
            continue;

        if (!line.startsWith('\t')) {
            // The vendor block is over, the device is not listed.
            if (inVendor)
                break;
            inVendor = new RegExp(`^${vendorId}\\s`).test(line);
        } else if (inVendor && !line.startsWith('\t\t')) {
            const match = /^\t([0-9a-f]{4})\s+(.+)$/.exec(line);
            if (match && match[1] === deviceId) {
                name = match[2].trim();
                break;
            }
        }
    }

    pciNameCache.set(key, name);
    return name;
}

// Icons ship with the extension: the theme has no CPU or memory icon. The
// -symbolic.svg suffix is what makes them follow the panel foreground color.
function deviceIcon(extension, name) {
    return Gio.icon_new_for_string(`${extension.path}/icons/${name}-symbolic.svg`);
}

// A titled separator with the device icon in front of the title.
function sectionHeader(gicon, title) {
    const item = new PopupMenu.PopupSeparatorMenuItem(title);
    item.insert_child_at_index(new St.Icon({
        gicon,
        icon_size: 16,
        style_class: 'sm-section-icon',
    }), 0);
    return item;
}

function formatPercent(value) {
    return value === null ? null : `${Math.round(value * 100)}%`;
}

function formatTemp(celsius) {
    return celsius === null ? null : `${Math.round(celsius)}°C`;
}

function formatWatts(watts) {
    if (watts === null)
        return null;
    return `${watts < 10 ? watts.toFixed(1) : Math.round(watts)} W`;
}

function formatGiB(bytes) {
    const value = bytes / GIB;
    return `${value < 10 ? value.toFixed(2) : value.toFixed(1)} GiB`;
}

function formatRate(bytesPerSecond) {
    if (bytesPerSecond === null)
        return null;
    if (bytesPerSecond >= MIB)
        return `${(bytesPerSecond / MIB).toFixed(1)} MiB/s`;
    return `${Math.round(bytesPerSecond / KIB)} KiB/s`;
}

function formatMHz(mhz) {
    if (mhz === null)
        return null;
    return mhz >= 1000 ? `${(mhz / 1000).toFixed(2)} GHz` : `${Math.round(mhz)} MHz`;
}

// 'warn' or 'crit' once a reading reaches its threshold, null below it or
// when there is no reading.
function levelOf(value, warn, crit) {
    if (value === null || value === undefined)
        return null;
    if (value >= crit)
        return 'crit';
    if (value >= warn)
        return 'warn';
    return null;
}

// Reads /proc and sysfs directly: the files are small and the values are
// already computed by the kernel, so no external tool is needed.
class CpuMonitor {
    constructor() {
        this._prevTimes = null;
        this._prevEnergy = null;
        this._lastProbe = 0;
        const chips = hwmonChips();
        this._tempPath = this._findTempPath(chips);
        this._powerPath = this._findPowerPath(chips);
        this._energyPaths = this._findEnergyPaths();
        this._freqPaths = this._findFreqPaths();
        this.model = this._findModel();
    }

    read() {
        return {
            usage: this._usage(),
            temp: this._temp(),
            power: this._power(),
            freq: this._freq(),
        };
    }

    _findModel() {
        const match = /^model name\s*:\s*(.+)$/m.exec(readFile('/proc/cpuinfo') ?? '');
        return match ? match[1].trim() : _('Processor');
    }

    // A known CPU chip first, then any chip labelling a package sensor, then
    // the kernel thermal zones, which is what ARM boards and virtual machines
    // usually expose. Nothing here is specific to one vendor.
    _findTempPath(chips) {
        for (const chip of CPU_TEMP_CHIPS) {
            const dir = chips.find(entry => entry.name === chip)?.dir;
            if (!dir)
                continue;

            const labelled = chipTempPath(dir);
            if (labelled)
                return labelled;

            const inputs = listDir(dir).filter(f => /^temp\d+_input$/.test(f)).sort();
            if (inputs.length > 0)
                return `${dir}/${inputs[0]}`;
        }

        // Unknown chip, an embedded controller for example: a package or Tctl
        // label still identifies the sensor without guessing.
        for (const {dir} of chips) {
            const path = chipTempPath(dir);
            if (path)
                return path;
        }

        for (const entry of listDir('/sys/class/thermal').sort()) {
            if (!/^thermal_zone\d+$/.test(entry))
                continue;

            const dir = `/sys/class/thermal/${entry}`;
            const type = readFile(`${dir}/type`)?.trim() ?? '';
            if (CPU_THERMAL_ZONE.test(type) && readNumber(`${dir}/temp`) !== null)
                return `${dir}/temp`;
        }
        return null;
    }

    // Fallback for platforms without readable energy counters: some chips,
    // zenpower among them, publish the CPU power draw directly in microwatts.
    _findPowerPath(chips) {
        for (const chip of CPU_TEMP_CHIPS) {
            const dir = chips.find(entry => entry.name === chip)?.dir;
            if (!dir)
                continue;

            for (const file of ['power1_average', 'power1_input']) {
                if (readNumber(`${dir}/${file}`) !== null)
                    return `${dir}/${file}`;
            }
        }
        return null;
    }

    // One entry per CPU package, from whatever powercap driver the platform
    // provides: intel-rapl covers both Intel and AMD, intel-rapl-mmio some
    // boards. energy_uj is root only unless a udev rule relaxes it, so
    // unreadable counters are dropped here and reported as unavailable
    // instead of failing on every refresh.
    _findEnergyPaths() {
        const packages = [];
        const platform = [];
        for (const entry of listDir('/sys/class/powercap')) {
            if (!POWERCAP_ZONE.test(entry))
                continue;

            const dir = `/sys/class/powercap/${entry}`;
            const name = readFile(`${dir}/name`)?.trim() ?? '';
            if (readNumber(`${dir}/energy_uj`) === null)
                continue;

            const zone = {
                energy: `${dir}/energy_uj`,
                max: readNumber(`${dir}/max_energy_range_uj`) ?? 0,
            };
            if (name.startsWith('package'))
                packages.push(zone);
            else if (name === 'psys')
                platform.push(zone);
        }

        // psys measures the whole platform, so it only stands in when no
        // package counter is readable: adding both would double count.
        return packages.length > 0 ? packages : platform;
    }

    // cpufreq is absent on some virtual machines, where /proc/cpuinfo is the
    // only source, so an empty list here is not the end of it.
    _findFreqPaths() {
        const base = '/sys/devices/system/cpu';
        const paths = [];
        for (const entry of listDir(base).sort()) {
            if (!/^cpu\d+$/.test(entry))
                continue;

            const dir = `${base}/${entry}/cpufreq`;
            for (const file of ['scaling_cur_freq', 'cpuinfo_cur_freq']) {
                if (readNumber(`${dir}/${file}`) !== null) {
                    paths.push(`${dir}/${file}`);
                    break;
                }
            }
        }
        return paths;
    }

    _usage() {
        const line = /^cpu\s+(.*)$/m.exec(readFile('/proc/stat') ?? '');
        if (!line)
            return null;

        const fields = line[1].trim().split(/\s+/).map(Number);
        const total = fields.reduce((sum, value) => sum + value, 0);
        const idle = (fields[3] ?? 0) + (fields[4] ?? 0);

        const prev = this._prevTimes;
        this._prevTimes = {total, idle};
        if (!prev)
            return null;

        const totalDelta = total - prev.total;
        if (totalDelta <= 0)
            return null;
        return Math.min(1, Math.max(0, 1 - (idle - prev.idle) / totalDelta));
    }

    _temp() {
        const value = this._tempPath ? readNumber(this._tempPath) : null;
        return value === null ? null : value / 1000;
    }

    // The energy counter when there is one, otherwise a direct hwmon reading.
    _power() {
        const energy = this._energyPower();
        if (energy !== null || this._energyPaths.length > 0)
            return energy;

        const watts = this._powerPath ? readNumber(this._powerPath) : null;
        return watts === null ? null : watts / 1e6;
    }

    // Watts derived from the energy counter delta between two refreshes.
    _energyPower() {
        const now = GLib.get_monotonic_time();

        // The counters can become readable mid session, once the udev rule is
        // installed, so an empty set is retried instead of being final.
        if (this._energyPaths.length === 0) {
            if (now - this._lastProbe < RAPL_RETRY * GLib.USEC_PER_SEC)
                return null;
            this._lastProbe = now;
            this._energyPaths = this._findEnergyPaths();
            if (this._energyPaths.length === 0)
                return null;
        }

        let total = 0;
        for (const path of this._energyPaths) {
            const value = readNumber(path.energy);
            if (value === null)
                return null;
            total += value;
        }

        const prev = this._prevEnergy;
        this._prevEnergy = {total, time: now};
        if (!prev)
            return null;

        const seconds = (now - prev.time) / GLib.USEC_PER_SEC;
        if (seconds <= 0)
            return null;

        let delta = total - prev.total;
        // The counter wraps at its own maximum, so one wrap is added back.
        if (delta < 0)
            delta += this._energyPaths.reduce((sum, path) => sum + path.max, 0);
        if (delta < 0)
            return null;

        return delta / 1e6 / seconds;
    }

    _freq() {
        if (this._freqPaths.length === 0)
            return this._cpuinfoFreq();

        let total = 0;
        let count = 0;
        for (const path of this._freqPaths) {
            const value = readNumber(path);
            if (value !== null) {
                total += value;
                count++;
            }
        }
        return count > 0 ? total / count / 1000 : null;
    }

    // Averaged over the cores, like the cpufreq reading, in MHz already.
    _cpuinfoFreq() {
        let total = 0;
        let count = 0;
        for (const line of (readFile('/proc/cpuinfo') ?? '').split('\n')) {
            const match = /^cpu MHz\s*:\s*([\d.]+)/.exec(line);
            if (match) {
                total += Number(match[1]);
                count++;
            }
        }
        return count > 0 ? total / count : null;
    }
}

class MemoryMonitor {
    read() {
        const text = readFile('/proc/meminfo');
        if (text === null)
            return null;

        const values = new Map();
        for (const line of text.split('\n')) {
            const match = /^(\w+):\s+(\d+)/.exec(line);
            if (match)
                values.set(match[1], Number(match[2]) * KIB);
        }

        const total = values.get('MemTotal') ?? 0;
        if (total === 0)
            return null;

        // MemAvailable already accounts for reclaimable cache.
        const available = values.get('MemAvailable') ?? values.get('MemFree') ?? 0;
        const swapTotal = values.get('SwapTotal') ?? 0;
        const swapUsed = swapTotal - (values.get('SwapFree') ?? 0);

        return {
            total,
            used: total - available,
            usage: (total - available) / total,
            swapTotal,
            swapUsed,
            swapUsage: swapTotal > 0 ? swapUsed / swapTotal : null,
        };
    }
}

// Space of one mount point, temperature of every drive that exposes it, and
// throughput derived from the kernel block counters.
class DiskMonitor {
    constructor() {
        this._prevIo = null;
        this.sensors = this._findTempSensors();
    }

    read(mount) {
        return {
            space: this._space(mount),
            temps: this.sensors.map(sensor => ({
                name: sensor.name,
                temp: this._readTemp(sensor.path),
            })),
            io: this._io(),
        };
    }

    // NVMe reports a Composite sensor and SATA drives expose drivetemp; any
    // other chip that hangs off a block device is taken as a drive too, so an
    // unusual controller is not left out by name.
    _findTempSensors() {
        const sensors = [];
        for (const {name: chip, dir} of hwmonChips()) {
            const known = chip === 'nvme' || chip === 'drivetemp';
            if (!known && listDir(`${dir}/device/block`).length === 0)
                continue;

            const inputs = listDir(dir).filter(f => /^temp\d+_input$/.test(f)).sort();
            let path = chipTempPath(dir, /composite/i);
            if (!path && inputs.length > 0)
                path = `${dir}/${inputs[0]}`;
            if (path)
                sensors.push({path, name: this._driveName(dir)});
        }
        return sensors;
    }

    _driveName(dir) {
        const model = readFile(`${dir}/device/model`)?.trim();
        if (model)
            return model;

        const block = listDir(`${dir}/device/block`)[0] ??
            listDir(`${dir}/device`).find(entry => DISK_DEVICE.test(entry));
        return block ?? _('Drive');
    }

    _readTemp(path) {
        const value = readNumber(path);
        return value === null ? null : value / 1000;
    }

    _space(mount) {
        try {
            const info = Gio.File.new_for_path(mount).query_filesystem_info(
                'filesystem::size,filesystem::used,filesystem::free', null);
            const total = info.get_attribute_uint64('filesystem::size');
            if (total === 0)
                return null;

            const used = info.has_attribute('filesystem::used')
                ? info.get_attribute_uint64('filesystem::used')
                : total - info.get_attribute_uint64('filesystem::free');
            return {total, used, usage: used / total};
        } catch {
            // Missing mount point, reported as unavailable.
            return null;
        }
    }

    // Sectors are always 512 bytes in /proc/diskstats, whatever the device
    // reports as its own sector size.
    _io() {
        const text = readFile('/proc/diskstats');
        if (text === null)
            return null;

        let readSectors = 0;
        let writeSectors = 0;
        for (const line of text.split('\n')) {
            const fields = line.trim().split(/\s+/);
            if (fields.length < 10 || !DISK_DEVICE.test(fields[2]))
                continue;
            readSectors += Number(fields[5]);
            writeSectors += Number(fields[9]);
        }

        const now = GLib.get_monotonic_time();
        const prev = this._prevIo;
        this._prevIo = {readSectors, writeSectors, time: now};
        if (!prev)
            return null;

        const seconds = (now - prev.time) / GLib.USEC_PER_SEC;
        if (seconds <= 0)
            return null;

        return {
            read: Math.max(0, (readSectors - prev.readSectors) * 512 / seconds),
            write: Math.max(0, (writeSectors - prev.writeSectors) * 512 / seconds),
        };
    }
}

// One card read through the kernel DRM and hwmon interfaces, which is what
// amdgpu, i915, xe, nouveau and radeon expose. Drivers publish different
// subsets of these files, and what is missing is reported as unavailable, so
// the same code serves every vendor.
class SysfsGpu {
    constructor(card) {
        this._base = `/sys/class/drm/${card}`;
        this._device = `${this._base}/device`;
        this._prevEnergy = null;

        const uevent = readFile(`${this._device}/uevent`) ?? '';
        this.driver = /^DRIVER=(.*)$/m.exec(uevent)?.[1]?.trim() ?? '';
        const id = /^PCI_ID=([0-9A-Fa-f]{4}):([0-9A-Fa-f]{4})/m.exec(uevent);
        this._vendorId = id ? id[1].toLowerCase() : null;
        this._deviceId = id ? id[2].toLowerCase() : null;

        this._hwmon = this._findHwmon();
        this._tempPath = this._hwmon ? chipTempPath(this._hwmon, /edge|junction|gpu/i) ??
            this._firstInput('temp') : null;
        this._powerPath = this._findPowerPath();
        this._powerCapPath = this._findFirst(this._hwmon,
            ['power1_cap', 'power1_max']);
        this._energyPath = this._findFirst(this._hwmon, ['energy1_input']);
        this._freqPath = this._findFreqPath();
        this.name = this._findName(card);
    }

    // A card with no readable sensor at all, a virtual framebuffer for
    // example, would only add an empty section to the menu.
    get hasSensors() {
        return this._tempPath !== null || this._powerPath !== null ||
            this._energyPath !== null || this._freqPath !== null ||
            readNumber(`${this._device}/gpu_busy_percent`) !== null ||
            readNumber(`${this._device}/mem_info_vram_total`) !== null;
    }

    read() {
        const busy = readNumber(`${this._device}/gpu_busy_percent`);
        const used = readNumber(`${this._device}/mem_info_vram_used`);
        const total = readNumber(`${this._device}/mem_info_vram_total`);
        const temp = this._tempPath ? readNumber(this._tempPath) : null;
        const cap = this._powerCapPath ? readNumber(this._powerCapPath) : null;
        const freq = this._freqPath ? readNumber(this._freqPath) : null;

        return {
            name: this.name,
            usage: busy === null ? null : Math.min(1, Math.max(0, busy / 100)),
            temp: temp === null ? null : temp / 1000,
            memoryUsed: used,
            memoryTotal: total,
            memoryUsage: used !== null && total ? used / total : null,
            power: this._power(),
            powerLimit: cap === null ? null : cap / 1e6,
            // freq1_input is in hertz, the i915 and xe files in megahertz.
            freq: freq === null ? null
                : (this._freqPath.endsWith('_mhz') ? freq : freq / 1e6),
        };
    }

    _findHwmon() {
        const dirs = listDir(`${this._device}/hwmon`).filter(e => /^hwmon\d+$/.test(e)).sort();
        return dirs.length > 0 ? `${this._device}/hwmon/${dirs[0]}` : null;
    }

    _firstInput(kind) {
        if (!this._hwmon)
            return null;
        const inputs = listDir(this._hwmon)
            .filter(f => new RegExp(`^${kind}\\d+_input$`).test(f)).sort();
        return inputs.length > 0 ? `${this._hwmon}/${inputs[0]}` : null;
    }

    _findFirst(dir, files) {
        if (!dir)
            return null;
        for (const file of files) {
            if (readNumber(`${dir}/${file}`) !== null)
                return `${dir}/${file}`;
        }
        return null;
    }

    // Average draw where the driver computes it, the instantaneous value
    // otherwise; discrete Intel cards only expose an energy counter.
    _findPowerPath() {
        return this._findFirst(this._hwmon, ['power1_average', 'power1_input']);
    }

    // amdgpu reports the shader clock in hwmon, the Intel drivers under the
    // card itself, with the gt subdirectory used by xe.
    _findFreqPath() {
        const candidates = [
            this._hwmon ? `${this._hwmon}/freq1_input` : null,
            `${this._base}/gt_cur_freq_mhz`,
            `${this._base}/gt/gt0/rps_cur_freq_mhz`,
        ];
        return candidates.find(path => path && readNumber(path) !== null) ?? null;
    }

    _findName(card) {
        const model = pciDeviceName(this._vendorId, this._deviceId);
        if (model)
            return model;

        const vendor = PCI_VENDORS.get(this._vendorId);
        return vendor ? `${vendor} ${_('GPU')}` : `${_('GPU')} ${card}`;
    }

    _power() {
        if (this._powerPath) {
            const value = readNumber(this._powerPath);
            return value === null ? null : value / 1e6;
        }
        if (!this._energyPath)
            return null;

        const total = readNumber(this._energyPath);
        const now = GLib.get_monotonic_time();
        const prev = this._prevEnergy;
        if (total === null)
            return null;

        this._prevEnergy = {total, time: now};
        if (!prev)
            return null;

        const seconds = (now - prev.time) / GLib.USEC_PER_SEC;
        const delta = total - prev.total;
        if (seconds <= 0 || delta < 0)
            return null;
        return delta / 1e6 / seconds;
    }
}

// NVIDIA cards are read with nvidia-smi, the only interface the proprietary
// driver exposes. Every other card, AMD and Intel included, is read from
// sysfs, so no extra tool is needed for them.
class GpuMonitor {
    constructor() {
        this._smi = GLib.find_program_in_path('nvidia-smi');
        this._cards = this._findCards();
    }

    get available() {
        return this._smi !== null || this._cards.length > 0;
    }

    async read() {
        const gpus = [];

        if (this._smi) {
            try {
                gpus.push(...await this._readNvidia());
            } catch {
                // Driver busy or missing: its cards are hidden this refresh.
            }
        }
        for (const card of this._cards)
            gpus.push(card.read());

        return gpus;
    }

    _findCards() {
        const cards = [];
        for (const entry of listDir('/sys/class/drm').sort()) {
            if (!/^card\d+$/.test(entry))
                continue;

            const card = new SysfsGpu(entry);
            // The proprietary driver publishes almost nothing in sysfs, and
            // nvidia-smi already reports those cards in full.
            if (card.driver === 'nvidia' && this._smi)
                continue;
            if (card.hasSensors)
                cards.push(card);
        }
        return cards;
    }

    async _readNvidia() {
        const out = await runCommand([this._smi,
            `--query-gpu=${NVIDIA_QUERY}`, '--format=csv,noheader,nounits']);

        const gpus = [];
        for (const line of out.split('\n')) {
            if (line.trim() === '')
                continue;

            const fields = line.split(',').map(field => field.trim());
            // Unsupported readings come back as [N/A] on some models.
            const number = index => {
                const value = Number(fields[index]);
                return Number.isFinite(value) ? value : null;
            };

            const used = number(3);
            const total = number(4);
            gpus.push({
                name: fields[0] ?? _('GPU'),
                usage: number(1) === null ? null : number(1) / 100,
                temp: number(2),
                memoryUsed: used === null ? null : used * MIB,
                memoryTotal: total === null ? null : total * MIB,
                memoryUsage: used !== null && total ? used / total : null,
                power: number(5),
                powerLimit: number(6),
                freq: number(7),
            });
        }
        return gpus;
    }
}

const LevelBar = GObject.registerClass(
class LevelBar extends St.BoxLayout {
    _init() {
        super._init({
            style_class: 'sm-bar',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._fill = new St.Widget({style_class: 'sm-bar-fill'});
        this.add_child(this._fill);
    }

    setValue(fraction, level = null) {
        const value = Math.min(1, Math.max(0, fraction ?? 0));
        this._fill.style = `width: ${Math.round(BAR_WIDTH * value)}px;`;
        this._fill.style_class = level ? `sm-bar-fill sm-bar-${level}` : 'sm-bar-fill';
    }
});

// A read only row: title on the left, optional bar, value on the right.
// Rows with a bar show the warning level on the bar, the others on the value.
const MetricRow = GObject.registerClass(
class MetricRow extends PopupMenu.PopupBaseMenuItem {
    _init(title, withBar = false) {
        super._init({
            reactive: false,
            can_focus: false,
            style_class: 'sm-row',
        });

        this._title = new St.Label({
            text: title,
            style_class: 'sm-row-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._title);

        if (withBar) {
            this._bar = new LevelBar();
            this.add_child(this._bar);
        }

        this._value = new St.Label({
            style_class: 'sm-row-value',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._value);
    }

    setTitle(title) {
        this._title.text = title;
    }

    // A null value hides the row, so unsupported sensors leave no empty line.
    update(text, fraction = null, level = null) {
        this.visible = text !== null;
        if (text === null)
            return;

        this._value.text = text;
        if (this._bar)
            this._bar.setValue(fraction, level);
        else
            this._value.style_class = level ? `sm-row-value sm-level-${level}` : 'sm-row-value';
    }
});

// One value in the panel. An invisible copy of the widest text it takes sits
// behind it, so the slot keeps its width while the number changes and the
// rest of the top bar does not move.
const PanelValue = GObject.registerClass(
class PanelValue extends St.Widget {
    _init(widest) {
        super._init({
            layout_manager: new Clutter.BinLayout(),
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._widest = new St.Label({
            text: widest,
            style_class: 'sm-chip-value',
            opacity: 0,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._widest);
        this._label = new St.Label({
            style_class: 'sm-chip-value',
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._label);
    }

    // widest replaces the reserved width, for values whose unit is a setting.
    update(text, level = null, widest = null) {
        this.visible = text !== null;
        if (text === null)
            return;

        if (widest !== null)
            this._widest.text = widest;
        this._label.text = text;
        this._label.style_class = level ? `sm-chip-value sm-level-${level}` : 'sm-chip-value';
    }
});

// One group of values in the panel, for example "CPU 12% 38 C 21 W".
const PanelChip = GObject.registerClass(
class PanelChip extends St.BoxLayout {
    _init(prefix, gicon, widths) {
        super._init({
            style_class: 'sm-chip',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._icon = new St.Icon({
            gicon,
            icon_size: 14,
            style_class: 'sm-chip-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._prefix = new St.Label({
            text: prefix,
            style_class: 'sm-chip-prefix',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._icon);
        this.add_child(this._prefix);

        this._values = widths.map(widest => {
            const value = new PanelValue(widest);
            this.add_child(value);
            return value;
        });
    }

    // One [text, level, widest] entry per value, in constructor order, the
    // last two optional; a null text hides that value.
    update(parts, style) {
        parts.forEach(([text, level, widest], i) =>
            this._values[i].update(text, level ?? null, widest ?? null));
        this.visible = this._values.some(value => value.visible);
        this._icon.visible = style === 'icon';
        this._prefix.visible = style === 'text';
    }
});

const StatusMonitorIndicator = GObject.registerClass(
class StatusMonitorIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.5, 'StatusMonitorGnome');

        this._extension = extension;
        this._settings = extension.getSettings();
        this._icons = {
            cpu: deviceIcon(extension, 'cpu'),
            memory: deviceIcon(extension, 'memory'),
            ssd: deviceIcon(extension, 'ssd'),
            gpu: deviceIcon(extension, 'gpu'),
        };
        this._cpu = new CpuMonitor();
        this._memory = new MemoryMonitor();
        this._disk = new DiskMonitor();
        this._gpu = new GpuMonitor();
        this._gpuRows = [];
        this._gpuSeparators = [];
        this._updating = false;
        this._destroyed = false;
        this._timeoutId = 0;

        this._buildPanel();
        this._buildMenu();

        this._settingsChangedId = this._settings.connect('changed', (_s, key) => {
            if (key === 'refresh-interval')
                this._restartTimer();
            else
                this._update();
        });

        this._menuOpenId = this.menu.connect('open-state-changed', (_menu, open) => {
            if (open)
                this._update();
        });

        this._restartTimer();
        this._update();
    }

    _buildPanel() {
        const box = new St.BoxLayout({style_class: 'panel-status-menu-box'});

        // Shown only when every value is hidden, so the button stays clickable.
        this._icon = new St.Icon({
            gicon: this._icons.cpu,
            style_class: 'system-status-icon',
            visible: false,
        });
        box.add_child(this._icon);

        this._cpuChip = new PanelChip(_('CPU'), this._icons.cpu,
            [WIDTH_PERCENT, WIDTH_TEMP, WIDTH_WATTS]);
        this._memoryChip = new PanelChip(_('RAM'), this._icons.memory,
            [WIDTH_PERCENT]);
        this._diskChip = new PanelChip(_('DISK'), this._icons.ssd,
            [WIDTH_PERCENT, WIDTH_TEMP, WIDTH_RATE]);
        this._gpuChip = new PanelChip(_('GPU'), this._icons.gpu,
            [WIDTH_PERCENT, WIDTH_GIB, WIDTH_TEMP, WIDTH_WATTS]);
        box.add_child(this._cpuChip);
        box.add_child(this._memoryChip);
        box.add_child(this._gpuChip);
        box.add_child(this._diskChip);

        this.add_child(box);
    }

    _buildMenu() {
        this.menu.addMenuItem(sectionHeader(this._icons.cpu, this._cpu.model));
        this._cpuUsageRow = new MetricRow(_('Usage'), true);
        this._cpuTempRow = new MetricRow(_('Temperature'));
        this._cpuPowerRow = new MetricRow(_('Power'));
        this._cpuFreqRow = new MetricRow(_('Frequency'));
        for (const row of [this._cpuUsageRow, this._cpuTempRow, this._cpuPowerRow, this._cpuFreqRow])
            this.menu.addMenuItem(row);

        this.menu.addMenuItem(sectionHeader(this._icons.memory, _('Memory')));
        this._memoryUsageRow = new MetricRow(_('In use'), true);
        this._swapRow = new MetricRow(_('Swap'), true);
        this.menu.addMenuItem(this._memoryUsageRow);
        this.menu.addMenuItem(this._swapRow);

        this._gpuSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._gpuSection);

        this.menu.addMenuItem(sectionHeader(this._icons.ssd, _('Storage')));
        this._diskUsageRow = new MetricRow(_('In use'), true);
        this._diskReadRow = new MetricRow(_('Read'));
        this._diskWriteRow = new MetricRow(_('Write'));
        this.menu.addMenuItem(this._diskUsageRow);
        this.menu.addMenuItem(this._diskReadRow);
        this.menu.addMenuItem(this._diskWriteRow);

        // Drives do not appear or disappear while the session runs, so one
        // temperature row per drive is enough.
        this._diskTempRows = this._disk.sensors.map(sensor => {
            const row = new MetricRow(sensor.name);
            this.menu.addMenuItem(row);
            return row;
        });

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const monitorItem = new PopupMenu.PopupImageMenuItem(
            _('System Monitor'), 'computer-symbolic');
        monitorItem.connect('activate', () => this._launchSystemMonitor());
        this.menu.addMenuItem(monitorItem);

        const prefsItem = new PopupMenu.PopupImageMenuItem(
            _('Settings'), 'preferences-system-symbolic');
        prefsItem.connect('activate', () => this._extension.openPreferences());
        this.menu.addMenuItem(prefsItem);
    }

    // GPU rows are created once the number of cards is known.
    _buildGpuRows(count) {
        this._gpuSection.removeAll();
        this._gpuRows = [];
        this._gpuSeparators = [];

        for (let i = 0; i < count; i++) {
            const separator = sectionHeader(this._icons.gpu, _('GPU'));
            this._gpuSection.addMenuItem(separator);
            this._gpuSeparators.push(separator);

            const rows = {
                usage: new MetricRow(_('Usage'), true),
                memory: new MetricRow(_('Memory'), true),
                temp: new MetricRow(_('Temperature')),
                power: new MetricRow(_('Power')),
                freq: new MetricRow(_('Frequency')),
            };
            for (const row of Object.values(rows))
                this._gpuSection.addMenuItem(row);
            this._gpuRows.push(rows);
        }
    }

    _restartTimer() {
        if (this._timeoutId)
            GLib.Source.remove(this._timeoutId);

        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT,
            this._settings.get_int('refresh-interval'), () => {
                this._update();
                return GLib.SOURCE_CONTINUE;
            });
    }

    async _update() {
        if (this._updating || this._destroyed)
            return;

        this._updating = true;
        try {
            const cpu = this._cpu.read();
            const memory = this._memory.read();
            const disk = this._disk.read(this._settings.get_string('disk-mount'));

            let gpus = [];
            if (this._gpu.available) {
                try {
                    gpus = await this._gpu.read();
                } catch {
                    // Driver busy or missing: the GPU section is hidden.
                    gpus = [];
                }
            }
            if (this._destroyed)
                return;

            this._renderMenu(cpu, memory, disk, gpus);
            this._renderPanel(cpu, memory, disk, gpus[0] ?? null);
        } finally {
            this._updating = false;
        }
    }

    // Level of a value against its own thresholds, for example cpu-temp or
    // gpu-vram. Null when coloring is off for that value.
    _level(metric, value) {
        if (!this._settings.get_boolean(`color-${metric}`))
            return null;
        return levelOf(value,
            this._settings.get_int(`${metric}-warn`),
            this._settings.get_int(`${metric}-crit`));
    }

    // Usage thresholds are percentages, the readings fractions.
    _usageLevel(metric, fraction) {
        return this._level(metric, fraction === null ? null : fraction * 100);
    }

    _renderMenu(cpu, memory, disk, gpus) {
        this._cpuUsageRow.update(formatPercent(cpu.usage), cpu.usage,
            this._usageLevel('cpu-usage', cpu.usage));
        this._cpuTempRow.update(formatTemp(cpu.temp), null,
            this._level('cpu-temp', cpu.temp));
        this._cpuPowerRow.update(formatWatts(cpu.power));
        this._cpuFreqRow.update(formatMHz(cpu.freq));

        if (memory) {
            this._memoryUsageRow.update(
                `${formatGiB(memory.used)} / ${formatGiB(memory.total)}`, memory.usage,
                this._usageLevel('memory-usage', memory.usage));
            this._swapRow.update(memory.swapTotal > 0
                ? `${formatGiB(memory.swapUsed)} / ${formatGiB(memory.swapTotal)}`
                : null, memory.swapUsage,
                this._usageLevel('memory-usage', memory.swapUsage));
        } else {
            this._memoryUsageRow.update(null);
            this._swapRow.update(null);
        }

        // The mount point is the row title, so several disks stay readable.
        this._diskUsageRow.setTitle(this._settings.get_string('disk-mount'));
        this._diskUsageRow.update(disk.space
            ? `${formatGiB(disk.space.used)} / ${formatGiB(disk.space.total)}`
            : null, disk.space?.usage,
            this._usageLevel('disk-usage', disk.space?.usage ?? null));
        this._diskReadRow.update(formatRate(disk.io?.read ?? null));
        this._diskWriteRow.update(formatRate(disk.io?.write ?? null));
        disk.temps.forEach((drive, i) => this._diskTempRows[i].update(
            formatTemp(drive.temp), null, this._level('disk-temp', drive.temp)));

        if (gpus.length !== this._gpuRows.length)
            this._buildGpuRows(gpus.length);

        gpus.forEach((gpu, i) => {
            const rows = this._gpuRows[i];
            this._gpuSeparators[i].label.text = gpu.name;
            rows.usage.update(formatPercent(gpu.usage), gpu.usage,
                this._usageLevel('gpu-usage', gpu.usage));
            rows.memory.update(gpu.memoryTotal
                ? `${formatGiB(gpu.memoryUsed)} / ${formatGiB(gpu.memoryTotal)}`
                : null, gpu.memoryUsage, this._usageLevel('gpu-vram', gpu.memoryUsage));
            rows.temp.update(formatTemp(gpu.temp), null, this._level('gpu-temp', gpu.temp));
            rows.power.update(gpu.powerLimit
                ? `${formatWatts(gpu.power)} / ${formatWatts(gpu.powerLimit)}`
                : formatWatts(gpu.power));
            rows.freq.update(formatMHz(gpu.freq));
        });
    }

    _renderPanel(cpu, memory, disk, gpu) {
        const show = key => this._settings.get_boolean(key);
        const style = this._settings.get_string('prefix-style');

        // VRAM in GiB by default, so it does not read as a second percentage.
        const vramPercent = this._settings.get_string('gpu-vram-unit') === 'percent';
        let vram = null;
        if (gpu?.memoryUsed != null)
            vram = vramPercent ? formatPercent(gpu.memoryUsage) : formatGiB(gpu.memoryUsed);

        this._cpuChip.update([
            [show('show-cpu-usage') ? formatPercent(cpu.usage) : null,
                this._usageLevel('cpu-usage', cpu.usage)],
            [show('show-cpu-temp') ? formatTemp(cpu.temp) : null,
                this._level('cpu-temp', cpu.temp)],
            [show('show-cpu-power') ? formatWatts(cpu.power) : null],
        ], style);

        this._memoryChip.update([
            [show('show-memory-usage') && memory ? formatPercent(memory.usage) : null,
                this._usageLevel('memory-usage', memory?.usage ?? null)],
        ], style);

        this._gpuChip.update([
            [show('show-gpu-usage') && gpu ? formatPercent(gpu.usage) : null,
                this._usageLevel('gpu-usage', gpu?.usage ?? null)],
            [show('show-gpu-vram') ? vram : null,
                this._usageLevel('gpu-vram', gpu?.memoryUsage ?? null),
                vramPercent ? WIDTH_PERCENT : WIDTH_GIB],
            [show('show-gpu-temp') && gpu ? formatTemp(gpu.temp) : null,
                this._level('gpu-temp', gpu?.temp ?? null)],
            [show('show-gpu-power') && gpu ? formatWatts(gpu.power) : null],
        ], style);

        const diskTemps = disk.temps.map(drive => drive.temp).filter(temp => temp !== null);
        // The hottest drive is the one worth watching in the panel.
        const diskTemp = diskTemps.length > 0 ? Math.max(...diskTemps) : null;
        const diskIo = disk.io ? disk.io.read + disk.io.write : null;
        this._diskChip.update([
            [show('show-disk-usage') && disk.space ? formatPercent(disk.space.usage) : null,
                this._usageLevel('disk-usage', disk.space?.usage ?? null)],
            [show('show-disk-temp') ? formatTemp(diskTemp) : null,
                this._level('disk-temp', diskTemp)],
            [show('show-disk-io') ? formatRate(diskIo) : null],
        ], style);

        this._icon.visible = !this._cpuChip.visible && !this._memoryChip.visible &&
            !this._diskChip.visible && !this._gpuChip.visible;
    }

    _launchSystemMonitor() {
        try {
            const app = Gio.AppInfo.create_from_commandline(
                'gnome-system-monitor', 'System Monitor', Gio.AppInfoCreateFlags.NONE);
            app.launch([], global.create_app_launch_context(0, -1));
        } catch (e) {
            Main.notifyError('StatusMonitorGnome', e.message);
        }
    }

    destroy() {
        this._destroyed = true;

        if (this._timeoutId) {
            GLib.Source.remove(this._timeoutId);
            this._timeoutId = 0;
        }
        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = 0;
        }
        if (this._menuOpenId) {
            this.menu.disconnect(this._menuOpenId);
            this._menuOpenId = 0;
        }

        this._settings = null;
        super.destroy();
    }
});

export default class StatusMonitorGnomeExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._settingsChangedId = this._settings.connect('changed', (_s, key) => {
            if (key === 'panel-box' || key === 'panel-position')
                this._addIndicator();
        });
        this._addIndicator();
    }

    disable() {
        this._settings.disconnect(this._settingsChangedId);
        this._settings = null;
        this._indicator?.destroy();
        this._indicator = null;
    }

    // Placed with an explicit position, so its order next to other indicators
    // does not depend on which extension is enabled first. A move rebuilds the
    // indicator, since the panel only places it when it is added.
    _addIndicator() {
        this._indicator?.destroy();
        this._indicator = new StatusMonitorIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator,
            this._settings.get_int('panel-position'),
            this._settings.get_string('panel-box'));
    }
}
