import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from
    'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

// The RAPL energy counter is root only until a udev rule relaxes it.
function cpuPowerAvailable() {
    for (let i = 0; i < 8; i++) {
        const dir = `/sys/class/powercap/intel-rapl:${i}`;
        try {
            const [ok, bytes] = GLib.file_get_contents(`${dir}/name`);
            if (!ok || !new TextDecoder().decode(bytes).startsWith('package'))
                continue;
            if (GLib.file_get_contents(`${dir}/energy_uj`)[0])
                return true;
        } catch {
            // Missing or unreadable: keep looking at the next package.
        }
    }
    return false;
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
                _('Unavailable: run enable-cpu-power.sh to allow reading the RAPL counter');
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
            description: _('Requires nvidia-smi in PATH'),
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
