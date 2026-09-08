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

// Fractions where a bar turns yellow and red.
const WARN_LEVEL = 0.75;
const CRIT_LEVEL = 0.90;

const KIB = 1024;
const MIB = 1024 * 1024;
const GIB = 1024 * 1024 * 1024;

// Seconds between attempts to find the RAPL counters while they stay
// unreadable, so installing the udev rule takes effect without a relogin.
const RAPL_RETRY = 15;

// Block devices, without their partitions, as named in /proc/diskstats.
const DISK_DEVICE = /^(nvme\d+n\d+|sd[a-z]+|vd[a-z]+|mmcblk\d+)$/;

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

// Reads /proc and sysfs directly: the files are small and the values are
// already computed by the kernel, so no external tool is needed.
class CpuMonitor {
    constructor() {
        this._prevTimes = null;
        this._prevEnergy = null;
        this._lastProbe = 0;
        this._tempPath = this._findTempPath();
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

    // Package temperature of the first known CPU chip, in preference order.
    _findTempPath() {
        const chips = new Map();
        for (const entry of listDir('/sys/class/hwmon')) {
            const dir = `/sys/class/hwmon/${entry}`;
            const name = readFile(`${dir}/name`)?.trim();
            if (name && !chips.has(name))
                chips.set(name, dir);
        }

        for (const chip of ['coretemp', 'k10temp', 'zenpower', 'cpu_thermal', 'acpitz']) {
            const dir = chips.get(chip);
            if (!dir)
                continue;

            const inputs = listDir(dir).filter(f => /^temp\d+_input$/.test(f)).sort();
            for (const input of inputs) {
                const label = readFile(`${dir}/${input.replace('_input', '_label')}`)?.trim() ?? '';
                if (/package|tctl|tdie/i.test(label))
                    return `${dir}/${input}`;
            }
            if (inputs.length > 0)
                return `${dir}/${inputs[0]}`;
        }
        return null;
    }

    // One entry per CPU package. energy_uj is root only unless a udev rule
    // relaxes it, so unreadable counters are dropped here and reported as
    // unavailable instead of failing on every refresh.
    _findEnergyPaths() {
        const paths = [];
        for (const entry of listDir('/sys/class/powercap')) {
            if (!/^intel-rapl:\d+$/.test(entry))
                continue;

            const dir = `/sys/class/powercap/${entry}`;
            const name = readFile(`${dir}/name`)?.trim() ?? '';
            if (!name.startsWith('package'))
                continue;
            if (readNumber(`${dir}/energy_uj`) === null)
                continue;

            paths.push({
                energy: `${dir}/energy_uj`,
                max: readNumber(`${dir}/max_energy_range_uj`) ?? 0,
            });
        }
        return paths;
    }

    _findFreqPaths() {
        const base = '/sys/devices/system/cpu';
        return listDir(base)
            .filter(entry => /^cpu\d+$/.test(entry))
            .map(entry => `${base}/${entry}/cpufreq/scaling_cur_freq`)
            .filter(path => readNumber(path) !== null);
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

    // Watts derived from the energy counter delta between two refreshes.
    _power() {
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
            return null;

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

    // NVMe reports a Composite sensor, SATA drives expose drivetemp.
    _findTempSensors() {
        const sensors = [];
        for (const entry of listDir('/sys/class/hwmon')) {
            const dir = `/sys/class/hwmon/${entry}`;
            const chip = readFile(`${dir}/name`)?.trim() ?? '';
            if (chip !== 'nvme' && chip !== 'drivetemp')
                continue;

            const inputs = listDir(dir).filter(f => /^temp\d+_input$/.test(f)).sort();
            let path = null;
            for (const input of inputs) {
                const label = readFile(`${dir}/${input.replace('_input', '_label')}`)?.trim() ?? '';
                if (/composite/i.test(label)) {
                    path = `${dir}/${input}`;
                    break;
                }
            }
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

// NVIDIA is the only backend: it is the one vendor that exposes usage,
// temperature and power draw through a single supported command.
class GpuMonitor {
    constructor() {
        this._smi = GLib.find_program_in_path('nvidia-smi');
    }

    get available() {
        return this._smi !== null;
    }

    async read() {
        if (!this._smi)
            return [];

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
                memoryUsed: used === null ? null : used * 1024 * 1024,
                memoryTotal: total === null ? null : total * 1024 * 1024,
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

    setValue(fraction) {
        const value = Math.min(1, Math.max(0, fraction ?? 0));
        this._fill.style = `width: ${Math.round(BAR_WIDTH * value)}px;`;

        let level = '';
        if (value >= CRIT_LEVEL)
            level = ' sm-bar-crit';
        else if (value >= WARN_LEVEL)
            level = ' sm-bar-warn';
        this._fill.style_class = `sm-bar-fill${level}`;
    }
});

// A read only row: title on the left, optional bar, value on the right.
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
    update(text, fraction = null) {
        this.visible = text !== null;
        if (text === null)
            return;

        this._value.text = text;
        this._bar?.setValue(fraction);
    }
});

// One group of values in the panel, for example "CPU 12% 38 C 21 W".
const PanelChip = GObject.registerClass(
class PanelChip extends St.BoxLayout {
    _init(prefix, gicon) {
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
        this._value = new St.Label({
            style_class: 'sm-chip-value',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._icon);
        this.add_child(this._prefix);
        this.add_child(this._value);
    }

    update(parts, style) {
        const values = parts.filter(part => part !== null);
        this.visible = values.length > 0;
        this._icon.visible = style === 'icon';
        this._prefix.visible = style === 'text';
        this._value.text = values.join(' ');
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

        this._cpuChip = new PanelChip(_('CPU'), this._icons.cpu);
        this._memoryChip = new PanelChip(_('RAM'), this._icons.memory);
        this._diskChip = new PanelChip(_('SSD'), this._icons.ssd);
        this._gpuChip = new PanelChip(_('GPU'), this._icons.gpu);
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

    _renderMenu(cpu, memory, disk, gpus) {
        this._cpuUsageRow.update(formatPercent(cpu.usage), cpu.usage);
        this._cpuTempRow.update(formatTemp(cpu.temp));
        this._cpuPowerRow.update(formatWatts(cpu.power));
        this._cpuFreqRow.update(formatMHz(cpu.freq));

        if (memory) {
            this._memoryUsageRow.update(
                `${formatGiB(memory.used)} / ${formatGiB(memory.total)}`, memory.usage);
            this._swapRow.update(memory.swapTotal > 0
                ? `${formatGiB(memory.swapUsed)} / ${formatGiB(memory.swapTotal)}`
                : null, memory.swapUsage);
        } else {
            this._memoryUsageRow.update(null);
            this._swapRow.update(null);
        }

        // The mount point is the row title, so several disks stay readable.
        this._diskUsageRow.setTitle(this._settings.get_string('disk-mount'));
        this._diskUsageRow.update(disk.space
            ? `${formatGiB(disk.space.used)} / ${formatGiB(disk.space.total)}`
            : null, disk.space?.usage);
        this._diskReadRow.update(formatRate(disk.io?.read ?? null));
        this._diskWriteRow.update(formatRate(disk.io?.write ?? null));
        disk.temps.forEach((drive, i) => this._diskTempRows[i].update(formatTemp(drive.temp)));

        if (gpus.length !== this._gpuRows.length)
            this._buildGpuRows(gpus.length);

        gpus.forEach((gpu, i) => {
            const rows = this._gpuRows[i];
            this._gpuSeparators[i].label.text = gpu.name;
            rows.usage.update(formatPercent(gpu.usage), gpu.usage);
            rows.memory.update(gpu.memoryTotal
                ? `${formatGiB(gpu.memoryUsed)} / ${formatGiB(gpu.memoryTotal)}`
                : null, gpu.memoryUsage);
            rows.temp.update(formatTemp(gpu.temp));
            rows.power.update(gpu.powerLimit
                ? `${formatWatts(gpu.power)} / ${formatWatts(gpu.powerLimit)}`
                : formatWatts(gpu.power));
            rows.freq.update(formatMHz(gpu.freq));
        });
    }

    _renderPanel(cpu, memory, disk, gpu) {
        const show = key => this._settings.get_boolean(key);
        const style = this._settings.get_string('prefix-style');

        this._cpuChip.update([
            show('show-cpu-usage') ? formatPercent(cpu.usage) : null,
            show('show-cpu-temp') ? formatTemp(cpu.temp) : null,
            show('show-cpu-power') ? formatWatts(cpu.power) : null,
        ], style);

        this._memoryChip.update([
            show('show-memory-usage') && memory ? formatPercent(memory.usage) : null,
        ], style);

        this._gpuChip.update([
            show('show-gpu-usage') && gpu ? formatPercent(gpu.usage) : null,
            // VRAM in GiB, so it does not read as a second percentage.
            show('show-gpu-vram') && gpu?.memoryUsed !== null && gpu !== null
                ? formatGiB(gpu.memoryUsed) : null,
            show('show-gpu-temp') && gpu ? formatTemp(gpu.temp) : null,
            show('show-gpu-power') && gpu ? formatWatts(gpu.power) : null,
        ], style);

        const diskTemps = disk.temps.map(drive => drive.temp).filter(temp => temp !== null);
        const diskIo = disk.io ? disk.io.read + disk.io.write : null;
        this._diskChip.update([
            show('show-disk-usage') && disk.space ? formatPercent(disk.space.usage) : null,
            // The hottest drive is the one worth watching in the panel.
            show('show-disk-temp') && diskTemps.length > 0
                ? formatTemp(Math.max(...diskTemps)) : null,
            show('show-disk-io') ? formatRate(diskIo) : null,
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
        this._indicator = new StatusMonitorIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
