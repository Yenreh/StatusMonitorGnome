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

function bindCombo(settings, key, row, values) {
    row.selected = Math.max(0, values.indexOf(settings.get_string(key)));
    row.connect('notify::selected', () => settings.set_string(key, values[row.selected]));
    settings.connect(`changed::${key}`, () => {
        const index = values.indexOf(settings.get_string(key));
        if (index >= 0 && index !== row.selected)
            row.selected = index;
    });
}

// GTK rejects an undefined subtitle in the initializer, so it is only set
// for the rows that actually carry one.
function addSwitch(settings, group, key, title, subtitle = '') {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    group.add(row);
    return row;
}

export default class StatusMonitorGnomePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage();
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
        addSwitch(settings, gpu, 'show-gpu-vram', _('Video memory'),
            _('Used VRAM in GiB'));
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
    }
}
