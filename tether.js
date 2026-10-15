import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import NM from 'gi://NM';

import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

// Kernel drivers used by phones for USB tethering (Android: rndis/ncm/ecm, iPhone: ipheth)
const PHONE_DRIVERS = ['rndis_host', 'cdc_ncm', 'cdc_ether', 'ipheth'];

const AF_INET = 2;
const AF_INET6 = 10;
const RESOLVED_NO_CACHE = 1 << 12;

// Used in "all traffic" mode to win over the other connections
const ROUTE_METRIC = 50;
const DNS_PRIORITY = -10;

const ACTIVATION_TIMEOUT = 30; // seconds
const GATEWAY_RETRIES = 5;

export const Mode = {
    OFF: 'off',
    ALL: 'all',
    SITES: 'sites',
};

/**
 * Calls a libnm `<method>_async`/`<method>_finish` pair and returns a promise.
 *
 * @param {object} obj - the object owning the method
 * @param {string} method - method name without the _async suffix
 * @param {...any} args - arguments before the callback
 * @returns {Promise<any>}
 */
function nmCall(obj, method, ...args) {
    return new Promise((resolve, reject) => {
        obj[`${method}_async`](...args, (o, res) => {
            try {
                resolve(o[`${method}_finish`](res));
            } catch (e) {
                reject(e);
            }
        });
    });
}

function isCancelled(e) {
    return e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

function formatAddress(family, bytes) {
    const b = Array.from(bytes);
    if (family === AF_INET)
        return b.join('.');
    const groups = [];
    for (let i = 0; i < 16; i += 2)
        groups.push(((b[i] << 8) | b[i + 1]).toString(16));
    return groups.join(':');
}

/**
 * Tracks the tethered phone and applies the routing modes to it.
 *
 * Every change is applied with Device.reapply() (like `nmcli device modify`):
 * it only touches the running connection and never the saved profile, so it
 * disappears by itself when the phone is unplugged.
 *
 * Signals: 'changed' (state to show), 'error' (message for the user),
 * 'phone-plugged' (the phone just became usable, not emitted at startup).
 */
export class TetherManager extends EventEmitter {
    constructor(settings) {
        super();

        this._settings = settings;
        this._cancellable = new Gio.Cancellable();
        this._client = null;
        this._device = null;
        this._timeouts = new Set();
        this._abortWait = null;
        this._sitesChanged = false;
        this._watchToken = {};
        this._ready = false;
        this._wasConnected = false;

        this.mode = Mode.OFF;
        this.busy = false;
        this.routedAddresses = [];

        this._settings.connectObject('changed::sites', () => this._onSitesChanged(), this);
        this._initClient().catch(e => {
            if (!isCancelled(e))
                logError(e, 'USB Tether Router');
        });
    }

    get phoneConnected() {
        return this._device !== null &&
            this._device.get_state() >= NM.DeviceState.DISCONNECTED;
    }

    get interfaceName() {
        return this._device?.get_iface() ?? null;
    }

    async _initClient() {
        this._client = await new Promise((resolve, reject) => {
            NM.Client.new_async(this._cancellable, (o, res) => {
                try {
                    resolve(NM.Client.new_finish(res));
                } catch (e) {
                    reject(e);
                }
            });
        });
        this._client.connectObject(
            'device-added', (c, device) => {
                this._watchDevice(device);
                this._findPhone();
            },
            'device-removed', (c, device) => {
                device.disconnectObject(this._watchToken);
                this._findPhone();
            },
            this);
        this._client.get_devices().forEach(d => this._watchDevice(d));
        this._findPhone();
        // A phone already there at startup is not "just plugged"
        this._ready = true;
    }

    // A just plugged phone can show up before NetworkManager knows its driver
    // or manages it: check again whenever one of those changes.
    _watchDevice(device) {
        device.connectObject(
            'notify::driver', () => this._findPhone(),
            'notify::managed', () => this._findPhone(),
            'state-changed', () => this._findPhone(),
            this._watchToken);
    }

    _findPhone() {
        const device = this._client.get_devices().find(d =>
            PHONE_DRIVERS.includes(d.get_driver()) && d.get_managed()) ?? null;
        if (device === this._device)
            return;

        // Phone unplugged: NetworkManager already dropped its runtime configuration
        this._device?.disconnectObject(this);
        this._abortWait?.(new Error(_('The phone was disconnected.')));
        this._device = device;
        this._resetMode();
        this._device?.connectObject('state-changed', () => this._onStateChanged(), this);
        this._emitChanged();
    }

    _onStateChanged() {
        // Disconnected from elsewhere (or unplugged): our changes are gone with it
        if (!this.busy && this.mode !== Mode.OFF &&
            this._device.get_state() !== NM.DeviceState.ACTIVATED)
            this._resetMode();
        this._emitChanged();
    }

    _emitChanged() {
        const connected = this.phoneConnected;
        const plugged = this._ready && connected && !this._wasConnected;
        this._wasConnected = connected;
        this.emit('changed');
        if (plugged)
            this.emit('phone-plugged');
    }

    _resetMode() {
        this.mode = Mode.OFF;
        this.routedAddresses = [];
    }

    _onSitesChanged() {
        if (this.mode !== Mode.SITES)
            return;
        if (this.busy) {
            this._sitesChanged = true;
            return;
        }
        const target = this._settings.get_strv('sites').length > 0 ? Mode.SITES : Mode.OFF;
        this.setMode(target);
    }

    /**
     * @param {string} mode - one of Mode
     */
    async setMode(mode) {
        if (this.busy)
            return;
        const device = this._device;
        if (!device || !this.phoneConnected) {
            this.emit('error', _('Phone not found: connect it via USB and turn on USB tethering.'));
            return;
        }

        this.busy = true;
        this._sitesChanged = false;
        this.emit('changed');
        try {
            if (mode === Mode.OFF) {
                if (device.get_state() === NM.DeviceState.ACTIVATED)
                    await nmCall(device, 'reapply', null, 0, 0, this._cancellable);
                this.routedAddresses = [];
            } else {
                const connection = await this._baseConnection(device);
                let addresses = [];
                if (mode === Mode.ALL)
                    this._configureAll(connection);
                else
                    addresses = await this._configureSites(device, connection);
                await nmCall(device, 'reapply', connection, 0, 0, this._cancellable);
                this.routedAddresses = addresses;
            }
            this.mode = mode;
        } catch (e) {
            if (isCancelled(e))
                return;
            this.emit('error', e.message);
        } finally {
            if (!this._cancellable.is_cancelled()) {
                this.busy = false;
                if (this._device !== device ||
                    device.get_state() !== NM.DeviceState.ACTIVATED)
                    this._resetMode();
                this.emit('changed');
                if (this._sitesChanged)
                    this._onSitesChanged();
            }
        }
    }

    /**
     * Makes sure the phone is connected and returns a copy of its saved
     * profile, to be modified and reapplied (clean starting point).
     *
     * @param {NM.Device} device - the phone
     * @returns {Promise<NM.Connection>}
     */
    async _baseConnection(device) {
        if (device.get_state() !== NM.DeviceState.ACTIVATED) {
            await nmCall(this._client, 'activate_connection', null, device, null, this._cancellable);
            await this._waitActivated(device);
        }
        const saved = device.get_active_connection()?.get_connection();
        if (!saved)
            throw new Error(_('Could not read the phone connection settings.'));
        return NM.SimpleConnection.new_clone(saved);
    }

    _waitActivated(device) {
        return new Promise((resolve, reject) => {
            let timeoutId = 0;
            const token = {};
            const finish = error => {
                device.disconnectObject(token);
                if (timeoutId)
                    GLib.source_remove(timeoutId);
                this._timeouts.delete(timeoutId);
                this._abortWait = null;
                if (error)
                    reject(error);
                else
                    resolve();
            };

            this._abortWait = finish;
            device.connectObject('state-changed', (d, state) => {
                if (state === NM.DeviceState.ACTIVATED)
                    finish();
                else if (state === NM.DeviceState.FAILED)
                    finish(new Error(_('The phone connection failed.')));
            }, token);
            timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, ACTIVATION_TIMEOUT, () => {
                timeoutId = 0;
                finish(new Error(_('Timed out while connecting to the phone.')));
                return GLib.SOURCE_REMOVE;
            });
            this._timeouts.add(timeoutId);
        });
    }

    _sleep(seconds) {
        return new Promise(resolve => {
            const id = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
                this._timeouts.delete(id);
                resolve();
                return GLib.SOURCE_REMOVE;
            });
            this._timeouts.add(id);
        });
    }

    _configureAll(connection) {
        for (const setting of [connection.get_setting_ip4_config(), connection.get_setting_ip6_config()]) {
            if (!setting)
                continue;
            setting.route_metric = ROUTE_METRIC;
            setting.dns_priority = DNS_PRIORITY;
        }
    }

    async _configureSites(device, connection) {
        const sites = this._settings.get_strv('sites');
        if (sites.length === 0)
            throw new Error(_('The site list is empty: add at least one site.'));

        // The gateway is read from the phone's DHCP reply (the IP config one can be empty)
        let gw4 = null;
        for (let i = 0; i < GATEWAY_RETRIES && !gw4; i++) {
            if (i > 0)
                await this._sleep(1);
            gw4 = this._gateway4(device);
        }
        if (!gw4)
            throw new Error(_('Could not find the phone gateway: try again in a few seconds.'));
        const gw6 = device.get_ip6_config()?.get_gateway() || null;

        // Resolve through the phone's DNS, the answer may differ from the usual network
        const ifindex = await this._ifindex(device);
        const routes4 = [];
        const routes6 = [];
        for (const site of sites) {
            routes4.push(...await this._resolve(ifindex, site, AF_INET));
            if (gw6)
                routes6.push(...await this._resolve(ifindex, site, AF_INET6));
        }
        if (routes4.length === 0 && routes6.length === 0)
            throw new Error(_('Could not resolve any site through the phone.'));

        const ip4 = connection.get_setting_ip4_config();
        const ip6 = connection.get_setting_ip6_config();
        if (!ip4)
            throw new Error(_('The phone connection has no IPv4 settings.'));

        ip4.never_default = true;
        ip4.clear_dns_searches();
        for (const site of sites)
            ip4.add_dns_search(`~${site}`);
        ip4.clear_routes();
        for (const ip of new Set(routes4))
            ip4.add_route(NM.IPRoute.new(AF_INET, ip, 32, gw4, -1));

        if (ip6) {
            ip6.never_default = true;
            ip6.clear_routes();
            for (const ip of new Set(routes6))
                ip6.add_route(NM.IPRoute.new(AF_INET6, ip, 128, gw6, -1));
        }

        return [...new Set([...routes4, ...routes6])];
    }

    async _ifindex(device) {
        const iface = device.get_ip_iface() || device.get_iface();
        const file = Gio.File.new_for_path(`/sys/class/net/${iface}/ifindex`);
        const [bytes] = await new Promise((resolve, reject) => {
            file.load_contents_async(this._cancellable, (f, res) => {
                try {
                    resolve(f.load_contents_finish(res));
                } catch (e) {
                    reject(e);
                }
            });
        });
        return parseInt(new TextDecoder().decode(bytes), 10);
    }

    _gateway4(device) {
        const options = device.get_dhcp4_config()?.get_options() ?? {};
        const router = options['routers']?.split(/[\s,]+/)[0];
        return router || device.get_ip4_config()?.get_gateway() || null;
    }

    _resolve(ifindex, name, family) {
        return new Promise((resolve, reject) => {
            Gio.DBus.system.call(
                'org.freedesktop.resolve1',
                '/org/freedesktop/resolve1',
                'org.freedesktop.resolve1.Manager',
                'ResolveHostname',
                new GLib.Variant('(isit)', [ifindex, name, family, RESOLVED_NO_CACHE]),
                new GLib.VariantType('(a(iiay)st)'),
                Gio.DBusCallFlags.NONE, -1, this._cancellable,
                (conn, res) => {
                    try {
                        const [addresses] = conn.call_finish(res).recursiveUnpack();
                        resolve(addresses
                            .filter(([, fam]) => fam === family)
                            .map(([, fam, bytes]) => formatAddress(fam, bytes)));
                    } catch (e) {
                        // A site that does not resolve is skipped, like the others
                        if (isCancelled(e))
                            reject(e);
                        else
                            resolve([]);
                    }
                });
        });
    }

    destroy() {
        // Give the phone its normal configuration back
        if (this.mode !== Mode.OFF && this._device?.get_state() === NM.DeviceState.ACTIVATED)
            this._device.reapply_async(null, 0, 0, null, null);

        this._cancellable.cancel();
        this._abortWait?.(new GLib.Error(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED, 'Cancelled'));
        for (const id of this._timeouts)
            GLib.source_remove(id);
        this._timeouts.clear();

        this._settings.disconnectObject(this);
        this._client?.disconnectObject(this);
        this._client?.get_devices().forEach(d => d.disconnectObject(this._watchToken));
        this._device?.disconnectObject(this);
        this._device = null;
        this._client = null;
        this._settings = null;
    }
}
