import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {TetherIndicator} from './indicator.js';
import {TetherManager} from './tether.js';

const PLACEMENT_SETTLE_DELAY = 50; // ms: collects a burst of insertions
const PLACEMENT_MAX_MOVES = 40; // moves after which we give up
const PLACEMENT_MOVES_WINDOW = 10000; // ms in which they are counted

export default class UsbTetherRouterExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._manager = new TetherManager(this._settings);
        this._zone = null;
        this._repositionId = 0;
        this._moves = [];
        this._createIndicator();

        // Moving the indicator means adding it to the panel again; the manager
        // (and so the active mode) is left untouched.
        this._settings.connectObject(
            'changed::panel-position', () => this._recreateIndicator(),
            'changed::panel-index', () => this._recreateIndicator(),
            this);

        // Kept enabled while locked (see session-modes) so the routing survives: only hide the menu
        Main.sessionMode.connectObject('updated', () => this._syncSessionMode(), this);
    }

    _createIndicator() {
        this._indicator = new TetherIndicator(this, this._settings, this._manager);
        Main.panel.addToStatusArea(this.uuid, this._indicator,
            this._settings.get_int('panel-index'),
            this._settings.get_string('panel-position'));
        this._watchZone();
        this._syncSessionMode();
    }

    _recreateIndicator() {
        this._unwatchZone();
        this._indicator?.destroy();
        this._indicator = null;
        this._createIndicator();
    }

    _syncSessionMode() {
        this._indicator.visible = !Main.sessionMode.isLocked;
        if (Main.sessionMode.isLocked)
            this._indicator.menu.close();
    }

    // addToStatusArea() puts the indicator at the chosen index, but whoever is
    // inserted before it later (tray icons after login, shell items re-added at
    // each session mode change) pushes it along: watch the area and move it back.
    _watchZone() {
        this._zone = this._indicator.container.get_parent();
        this._moves = [];
        this._zone?.connectObject(
            'child-added', () => this._scheduleReposition(),
            'child-removed', () => this._scheduleReposition(),
            this);
    }

    _unwatchZone() {
        if (this._repositionId) {
            GLib.source_remove(this._repositionId);
            this._repositionId = 0;
        }
        this._zone?.disconnectObject(this);
        this._zone = null;
    }

    _scheduleReposition() {
        if (this._repositionId)
            return;
        this._repositionId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PLACEMENT_SETTLE_DELAY, () => {
            this._repositionId = 0;
            this._reposition();
            return GLib.SOURCE_REMOVE;
        });
    }

    _reposition() {
        const container = this._indicator?.container;
        if (!container || !this._zone || container.get_parent() !== this._zone)
            return;

        const children = this._zone.get_children();
        const target = Math.min(this._settings.get_int('panel-index'), children.length - 1);
        if (target < 0 || children.indexOf(container) === target)
            return;

        // If another extension claims the same spot the same way, stop rather
        // than swapping places forever
        const now = GLib.get_monotonic_time() / 1000;
        this._moves = this._moves.filter(t => now - t < PLACEMENT_MOVES_WINDOW);
        if (this._moves.length >= PLACEMENT_MAX_MOVES) {
            this._unwatchZone();
            return;
        }
        this._moves.push(now);
        this._zone.set_child_at_index(container, target);
    }

    disable() {
        Main.sessionMode.disconnectObject(this);
        this._settings.disconnectObject(this);
        this._unwatchZone();
        this._indicator?.destroy();
        this._indicator = null;
        // Restores the phone's normal configuration if a mode was active
        this._manager?.destroy();
        this._manager = null;
        this._settings = null;
    }
}
