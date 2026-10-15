import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {normalizeSite} from './sites.js';

const PANEL_POSITIONS = ['left', 'center', 'right'];

export default class UsbTetherRouterPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings;

        const page = new Adw.PreferencesPage();
        window.add(page);

        const group = new Adw.PreferencesGroup({
            title: _('Sites via phone'),
            description: _('In “Only listed sites” mode these sites go through the phone, everything else keeps using your usual connection. URLs are accepted: only the domain is kept.'),
        });
        page.add(group);

        const entry = new Adw.EntryRow({
            title: _('Add site (URL or domain)…'),
            show_apply_button: true,
        });
        const addSite = () => {
            const site = normalizeSite(entry.text);
            if (!site) {
                entry.add_css_class('error');
                return;
            }
            entry.remove_css_class('error');
            const sites = settings.get_strv('sites');
            if (!sites.includes(site))
                settings.set_strv('sites', [...sites, site]);
            entry.text = '';
        };
        entry.connect('apply', addSite);
        entry.connect('entry-activated', addSite);
        entry.connect('changed', () => entry.remove_css_class('error'));
        group.add(entry);

        let rows = [];
        const rebuild = () => {
            rows.forEach(row => group.remove(row));
            rows = settings.get_strv('sites').map(site => {
                const row = new Adw.ActionRow({title: site});
                const button = new Gtk.Button({
                    icon_name: 'user-trash-symbolic',
                    tooltip_text: _('Remove site'),
                    valign: Gtk.Align.CENTER,
                    css_classes: ['flat'],
                });
                button.connect('clicked', () => {
                    settings.set_strv('sites', settings.get_strv('sites').filter(s => s !== site));
                });
                row.add_suffix(button);
                group.add(row);
                return row;
            });
        };
        settings.connect('changed::sites', rebuild);
        rebuild();

        const look = new Adw.PreferencesGroup({
            title: _('Top bar'),
            description: _('The icon is blue while all traffic goes through the phone and green while only the listed sites do.'),
        });
        page.add(look);

        const position = new Adw.ComboRow({
            title: _('Top bar area'),
            model: Gtk.StringList.new([_('Left'), _('Center'), _('Right')]),
            selected: Math.max(0, PANEL_POSITIONS.indexOf(settings.get_string('panel-position'))),
        });
        position.connect('notify::selected', row => {
            settings.set_string('panel-position', PANEL_POSITIONS[row.selected]);
        });
        look.add(position);

        const index = new Adw.SpinRow({
            title: _('Position within the area'),
            subtitle: _('0 = at the start of the area'),
            adjustment: new Gtk.Adjustment({lower: 0, upper: 20, step_increment: 1}),
        });
        settings.bind('panel-index', index, 'value', Gio.SettingsBindFlags.DEFAULT);
        look.add(index);

        const openOnConnect = new Adw.SwitchRow({
            title: _('Open the menu when the phone is connected'),
            subtitle: _('A reminder to choose a mode'),
        });
        settings.bind('open-menu-on-connect', openOnConnect, 'active', Gio.SettingsBindFlags.DEFAULT);
        look.add(openOnConnect);

        const tips = new Adw.PreferencesGroup({title: _('If a site does not open')});
        page.add(tips);
        for (const tip of [
            _('Turn off “Secure DNS” (DNS over HTTPS) in the browser, otherwise it ignores the system DNS.'),
            _('Add the other domains the site uses (CDN, images…).'),
            _('If the site addresses changed, choose the mode again from the menu.'),
        ]) {
            tips.add(new Adw.ActionRow({title: tip, title_lines: 0}));
        }
    }
}
