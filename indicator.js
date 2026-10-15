import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {gettext as _, ngettext} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Mode} from './tether.js';
import {normalizeSite} from './sites.js';

function iconButton(iconName, accessibleName) {
    return new St.Button({
        style_class: 'button usb-tether-button-small',
        accessible_name: accessibleName,
        can_focus: true,
        y_align: Clutter.ActorAlign.CENTER,
        child: new St.Icon({icon_name: iconName, style_class: 'popup-menu-icon'}),
    });
}

export const TetherIndicator = GObject.registerClass(
class TetherIndicator extends PanelMenu.Button {
    _init(extension, settings, manager) {
        super._init(0.5, _('USB Tether Router'));
        this.add_style_class_name('usb-tether-button');

        this._extension = extension;
        this._settings = settings;
        this._manager = manager;

        this._icon = new St.Icon({style_class: 'system-status-icon usb-tether-icon'});
        this.add_child(this._icon);
        this._lightPanel = null;
        this.connect('style-changed', () => this._updatePanelTone());

        this._statusItem = new PopupMenu.PopupMenuItem('', {reactive: false});
        this.menu.addMenuItem(this._statusItem);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._modeItems = new Map();
        for (const [mode, label] of [
            [Mode.ALL, _('All traffic via phone')],
            [Mode.SITES, _('Only listed sites via phone')],
            [Mode.OFF, _('Off')],
        ]) {
            const item = new PopupMenu.PopupMenuItem(label);
            item.connect('activate', () => this._manager.setMode(mode));
            this.menu.addMenuItem(item);
            this._modeItems.set(mode, item);
        }

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(_('Sites via phone')));
        this._sitesSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._sitesSection);
        this._emptyItem = new PopupMenu.PopupMenuItem(_('No sites yet'), {reactive: false});
        this.menu.addMenuItem(this._emptyItem);
        this._addEntryItem();

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const prefsItem = new PopupMenu.PopupMenuItem(_('Preferences'));
        prefsItem.connect('activate', () => this._extension.openPreferences());
        this.menu.addMenuItem(prefsItem);

        this._settings.connectObject('changed::sites', () => this._rebuildSites(), this);
        this._manager.connectObject(
            'changed', () => this._sync(),
            'error', (m, message) => Main.notify(_('USB Tether Router'), message),
            'phone-plugged', () => this._onPhonePlugged(),
            this);

        this._rebuildSites();
        this._sync();
    }

    // Reminds to choose a mode as soon as the phone is plugged in
    _onPhonePlugged() {
        if (this._settings.get_boolean('open-menu-on-connect') &&
            this.visible && !Main.sessionMode.isLocked)
            this.menu.open();
    }

    _addEntryItem() {
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        this._entry = new St.Entry({
            style_class: 'usb-tether-entry',
            hint_text: _('Add site (URL or domain)…'),
            can_focus: true,
            x_expand: true,
        });
        this._entry.clutter_text.connect('activate', () => this._addSite());
        const button = iconButton('list-add-symbolic', _('Add site'));
        button.connect('clicked', () => this._addSite());
        item.add_child(this._entry);
        item.add_child(button);
        this.menu.addMenuItem(item);
    }

    _addSite() {
        const text = this._entry.get_text();
        if (!text.trim())
            return;
        const site = normalizeSite(text);
        if (!site) {
            Main.notify(_('USB Tether Router'), _('“%s” is not a valid site.').format(text.trim()));
            return;
        }
        const sites = this._settings.get_strv('sites');
        if (!sites.includes(site))
            this._settings.set_strv('sites', [...sites, site]);
        this._entry.set_text('');
    }

    _removeSite(site) {
        const sites = this._settings.get_strv('sites').filter(s => s !== site);
        this._settings.set_strv('sites', sites);
    }

    _rebuildSites() {
        this._sitesSection.removeAll();
        const sites = this._settings.get_strv('sites');
        for (const site of sites) {
            const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
            item.add_child(new St.Label({
                text: site,
                style_class: 'usb-tether-site-label',
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            }));
            const button = iconButton('list-remove-symbolic', _('Remove site'));
            button.connect('clicked', () => this._removeSite(site));
            item.add_child(button);
            this._sitesSection.addMenuItem(item);
        }
        this._emptyItem.visible = sites.length === 0;
    }

    _sync() {
        const m = this._manager;
        const connected = m.phoneConnected;

        this._icon.icon_name = connected
            ? 'network-wired-symbolic'
            : 'network-wired-disconnected-symbolic';
        // Colored while the phone is in use: blue for all traffic, green for the listed sites
        this._icon.remove_style_class_name('usb-tether-all');
        this._icon.remove_style_class_name('usb-tether-sites');
        if (connected && m.mode === Mode.ALL)
            this._icon.add_style_class_name('usb-tether-all');
        else if (connected && m.mode === Mode.SITES)
            this._icon.add_style_class_name('usb-tether-sites');

        let status;
        if (!connected)
            status = _('Phone not connected');
        else if (m.busy)
            status = _('Applying…');
        else if (m.mode === Mode.ALL)
            status = _('All traffic goes through %s').format(m.interfaceName);
        else if (m.mode === Mode.SITES)
            status = ngettext('%d address goes through %s', '%d addresses go through %s',
                m.routedAddresses.length).format(m.routedAddresses.length, m.interfaceName);
        else
            status = _('Phone connected (%s), not in use').format(m.interfaceName);
        this._statusItem.label.text = status;

        for (const [mode, item] of this._modeItems) {
            item.setOrnament(mode === m.mode ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NO_DOT);
            item.sensitive = connected && !m.busy;
        }
    }

    // The colors have a darker variant for light panels: detected from the text
    // color the theme gives the button, since a dark panel can come with a light theme.
    _updatePanelTone() {
        const fg = this.get_theme_node().get_foreground_color();
        const light = (0.299 * fg.red + 0.587 * fg.green + 0.114 * fg.blue) / 255 < 0.5;
        if (light === this._lightPanel)
            return;
        this._lightPanel = light;
        if (light)
            this.add_style_class_name('usb-tether-light-panel');
        else
            this.remove_style_class_name('usb-tether-light-panel');
    }

    destroy() {
        this._settings.disconnectObject(this);
        this._manager.disconnectObject(this);
        super.destroy();
    }
});
