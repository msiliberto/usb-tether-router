# USB Tether Router

GNOME Shell extension to use a phone connected via **USB tethering** in two ways:

- **All traffic via phone** – every connection goes through the phone.
- **Only listed sites via phone** – your usual connection (e.g. Wi‑Fi) is used for everything,
  except the sites in your list, which go through the phone.

Click the network icon in the top bar to choose the mode and to add or remove sites
(full URLs are accepted, only the domain is kept). The list can also be edited in the preferences.

## How it works

The extension uses NetworkManager to change only the *running* configuration of the phone
connection (like `nmcli device modify`); the saved profile is never touched. The changes
are dropped when:

- the phone is unplugged (or tethering is turned off);
- you choose **Off**;
- the extension is disabled, or you log out / restart.

The site list is the only thing that is saved.

In “only listed sites” mode each site is resolved through the phone's DNS, a host route
(`/32`, `/128`) is added for each address via the phone gateway, and the domain is set as a
DNS routing domain (`~example.com`) on the phone interface, so systemd-resolved asks the
phone's DNS for it.

Supported phones: Android (`rndis_host`, `cdc_ncm`, `cdc_ether`) and iPhone (`ipheth`).

Requirements: NetworkManager and systemd-resolved.

## If a site does not open

- Turn off “Secure DNS” (DNS over HTTPS) in the browser, otherwise it ignores the system DNS.
- Add the other domains the site uses (CDN, images…).
- If the site addresses changed, choose the mode again from the menu.

## Install from source

```sh
gnome-extensions pack --force \
  --extra-source=indicator.js --extra-source=tether.js --extra-source=sites.js \
  --podir=po .
gnome-extensions install --force usb-tether-router@msiliberto.github.io.shell-extension.zip
```

Log out and back in (Wayland), then:

```sh
gnome-extensions enable usb-tether-router@msiliberto.github.io
```

`--podir` needs `msgfmt` (package `gettext`).

## Translations

Update the template with:

```sh
xgettext --from-code=UTF-8 -k_ -kngettext:1,2 -o po/usb-tether-router.pot *.js
```

## License

GPL-2.0-or-later
