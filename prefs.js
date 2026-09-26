import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from
    'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

function readFile(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        return ok ? new TextDecoder().decode(bytes) : null;
    } catch {
        return null;
    }
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
        // Missing directory: nothing to report.
    }
    return names;
}

// The energy counter is root only until a udev rule relaxes it. Any powercap
// package zone counts, so Intel and AMD are both covered; a chip publishing
// watts directly, zenpower for example, works without any rule.
function cpuPowerAvailable() {
    for (const entry of listDir('/sys/class/powercap')) {
        if (!/^[\w.-]+:\d+$/.test(entry))
            continue;

        const dir = `/sys/class/powercap/${entry}`;
        if (!(readFile(`${dir}/name`) ?? '').startsWith('package'))
            continue;
        if (readFile(`${dir}/energy_uj`) !== null)
            return true;
    }

    for (const entry of listDir('/sys/class/hwmon')) {
        const dir = `/sys/class/hwmon/${entry}`;
        const chip = readFile(`${dir}/name`)?.trim() ?? '';
        if (!/^(coretemp|k10temp|zenpower|k8temp)$/.test(chip))
            continue;
        if (readFile(`${dir}/power1_average`) !== null ||
            readFile(`${dir}/power1_input`) !== null)
            return true;
    }
    return false;
}

// What the GPU group can actually show on this machine.
function gpuDescription() {
    const nvidia = GLib.find_program_in_path('nvidia-smi') !== null;
    const cards = listDir('/sys/class/drm')
        .filter(entry => /^card\d+$/.test(entry))
        .some(entry => readFile(`/sys/class/drm/${entry}/device/uevent`) !== null);

    if (nvidia)
        return _('NVIDIA cards are read with nvidia-smi, other cards from the kernel');
    if (cards)
        return _('Read from the kernel; values the driver does not publish stay hidden');
    return _('No card detected. NVIDIA needs nvidia-smi in PATH');
}

const PREFIX_STYLES = ['icon', 'text', 'none'];
const VRAM_UNITS = ['gib', 'percent'];
const PANEL_BOXES = ['left', 'center', 'right'];

function bindCombo(settings, key, row, values) {
    row.selected = Math.max(0, values.indexOf(settings.get_string(key)));
    row.connect('notify::selected', () => settings.set_string(key, values[row.selected]));
    settings.connect(`changed::${key}`, () => {
        const index = values.indexOf(settings.get_string(key));
        if (index >= 0 && index !== row.selected)
            row.selected = index;
    });
}

// Where the indicator sits in the top bar.
function addPlacementGroup(settings, page) {
    const group = new Adw.PreferencesGroup({
        title: _('Position'),
        description: _('Where the indicator sits in the top bar'),
    });
    page.add(group);

    const boxRow = new Adw.ComboRow({
        title: _('Area'),
        model: new Gtk.StringList({strings: [_('Left'), _('Center'), _('Right')]}),
    });
    bindCombo(settings, 'panel-box', boxRow, PANEL_BOXES);
    group.add(boxRow);

    const positionRow = new Adw.SpinRow({
        title: _('Order'),
        subtitle: _('Lower numbers go further left within the area'),
        adjustment: new Gtk.Adjustment({lower: 0, upper: 20, step_increment: 1}),
    });
    settings.bind('panel-position', positionRow, 'value', Gio.SettingsBindFlags.DEFAULT);
    group.add(positionRow);
}

// Rows go into a preferences group or nested in an expander row.
function append(parent, row) {
    if (parent instanceof Adw.ExpanderRow)
        parent.add_row(row);
    else
        parent.add(row);
}

// GTK rejects an undefined subtitle in the initializer, so it is only set
// for the rows that actually carry one.
function addSwitch(settings, group, key, title, subtitle = '') {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    append(group, row);
    return row;
}

function addSpin(settings, parent, key, title, lower, upper) {
    const row = new Adw.SpinRow({
        title,
        adjustment: new Gtk.Adjustment({
            lower,
            upper,
            step_increment: 1,
            page_increment: 5,
        }),
    });
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    append(parent, row);
    return row;
}

// One colored value: the switch turns coloring on and unlocks its own
// warning and critical thresholds, nested below it.
function addColor(settings, group, metric, title, unit, lower, upper) {
    const row = new Adw.ExpanderRow({title, show_enable_switch: true});
    settings.bind(`color-${metric}`, row, 'enable-expansion', Gio.SettingsBindFlags.DEFAULT);
    group.add(row);

    addSpin(settings, row, `${metric}-warn`, `${_('Warning at')} (${unit})`, lower, upper);
    addSpin(settings, row, `${metric}-crit`, `${_('Critical at')} (${unit})`, lower, upper);
}

export default class StatusMonitorGnomePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: _('Panel'),
            icon_name: 'preferences-system-symbolic',
        });
        window.add(page);

        const cpu = new Adw.PreferencesGroup({
            title: _('CPU'),
            description: _('Values shown next to the CPU prefix in the panel'),
        });
        page.add(cpu);
        addSwitch(settings, cpu, 'show-cpu-usage', _('Usage'));
        addSwitch(settings, cpu, 'show-cpu-temp', _('Temperature'));
        const powerRow = addSwitch(settings, cpu, 'show-cpu-power', _('Power'));
        if (!cpuPowerAvailable()) {
            powerRow.subtitle =
                _('Unavailable: run enable-cpu-power.sh to allow reading the energy counter');
        }

        const memory = new Adw.PreferencesGroup({title: _('Memory')});
        page.add(memory);
        addSwitch(settings, memory, 'show-memory-usage', _('Usage'));

        const disk = new Adw.PreferencesGroup({
            title: _('Storage'),
            description: _('Temperature comes from every drive that reports it'),
        });
        page.add(disk);
        addSwitch(settings, disk, 'show-disk-usage', _('Used space'));
        addSwitch(settings, disk, 'show-disk-temp', _('Temperature'),
            _('Hottest drive'));
        addSwitch(settings, disk, 'show-disk-io', _('Activity'),
            _('Combined read and write throughput'));

        const mountRow = new Adw.EntryRow({title: _('Mount point')});
        settings.bind('disk-mount', mountRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        disk.add(mountRow);

        const gpu = new Adw.PreferencesGroup({
            title: _('GPU'),
            description: gpuDescription(),
        });
        page.add(gpu);
        addSwitch(settings, gpu, 'show-gpu-usage', _('Usage'));
        addSwitch(settings, gpu, 'show-gpu-vram', _('Video memory'), _('Used VRAM'));
        const vramUnitRow = new Adw.ComboRow({
            title: _('Video memory unit'),
            model: new Gtk.StringList({strings: [_('GiB'), _('Percentage')]}),
        });
        bindCombo(settings, 'gpu-vram-unit', vramUnitRow, VRAM_UNITS);
        settings.bind('show-gpu-vram', vramUnitRow, 'sensitive', Gio.SettingsBindFlags.GET);
        gpu.add(vramUnitRow);
        addSwitch(settings, gpu, 'show-gpu-temp', _('Temperature'));
        addSwitch(settings, gpu, 'show-gpu-power', _('Power'));

        const general = new Adw.PreferencesGroup({title: _('General')});
        page.add(general);
        const prefixRow = new Adw.ComboRow({
            title: _('Device marker'),
            subtitle: _('Shown in front of each group of panel values'),
            model: new Gtk.StringList({strings: [_('Icon'), _('Text'), _('None')]}),
        });
        bindCombo(settings, 'prefix-style', prefixRow, PREFIX_STYLES);
        general.add(prefixRow);

        const intervalRow = new Adw.SpinRow({
            title: _('Refresh interval'),
            subtitle: _('Seconds between sensor readings'),
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 60,
                step_increment: 1,
                page_increment: 5,
            }),
        });
        settings.bind('refresh-interval', intervalRow, 'value',
            Gio.SettingsBindFlags.DEFAULT);
        general.add(intervalRow);

        addPlacementGroup(settings, page);

        this._fillColorsPage(window, settings);
    }

    _fillColorsPage(window, settings) {
        const page = new Adw.PreferencesPage({
            title: _('Colors'),
            icon_name: 'color-select-symbolic',
            description: _('Each value turns yellow at its warning threshold and red at ' +
                'its critical one, in the panel and the menu'),
        });
        window.add(page);

        const cpu = new Adw.PreferencesGroup({title: _('CPU')});
        page.add(cpu);
        addColor(settings, cpu, 'cpu-usage', _('Usage'), '%', 1, 100);
        addColor(settings, cpu, 'cpu-temp', _('Temperature'), '°C', 20, 120);

        const memory = new Adw.PreferencesGroup({
            title: _('Memory'),
            description: _('Swap follows the same thresholds'),
        });
        page.add(memory);
        addColor(settings, memory, 'memory-usage', _('Usage'), '%', 1, 100);

        const gpu = new Adw.PreferencesGroup({title: _('GPU')});
        page.add(gpu);
        addColor(settings, gpu, 'gpu-usage', _('Usage'), '%', 1, 100);
        addColor(settings, gpu, 'gpu-vram', _('Video memory'), '%', 1, 100);
        addColor(settings, gpu, 'gpu-temp', _('Temperature'), '°C', 20, 120);

        const disk = new Adw.PreferencesGroup({title: _('Storage')});
        page.add(disk);
        addColor(settings, disk, 'disk-usage', _('Used space'), '%', 1, 100);
        addColor(settings, disk, 'disk-temp', _('Temperature'), '°C', 20, 120);
    }
}
