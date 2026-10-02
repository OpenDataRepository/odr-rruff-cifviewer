# ODR RRUFF CIF Viewer

Reads a CIF file and builds the AMC header, AMC → CIF conversion, and
formatted citation for an AMCSD record. The record itself is loaded from the
ODR RRUFF API using the `?UUID=<record-uuid>` in the page URL.

It can be run two ways:

- **[WordPress plugin](#wordpress-plugin)**, in `wordpress-plugin/odr-rruff-cifviewer/`
- **[Standalone local server](#standalone-local-server)**, from the repo root with `node server.js` (for personal testing)

## How the API login works (read this first)

Both setups log in to the ODR API **on the server, not in the browser**:

1. The server reads your API username/password from a `.env` file.
2. The server POSTs them to `https://www.rruff.net/odr_rruff/api/v4/token` and gets a token.
3. The server calls
   `https://www.rruff.net/odr_rruff/api/v4/dataset/record/<uuid>` with the token and
   passes the JSON back.

## WordPress plugin

### 1. Install the plugin

Upload the `wordpress-plugin/odr-rruff-cifviewer/` folder to
`wp-content/plugins/odr-rruff-cifviewer/`, either by copying the folder or by
zipping it and using **Plugins → Add New → Upload Plugin**. Then activate
**ODR RRUFF CIF Viewer**.

### 2. Composer (optional)

```bash
composer install
```

Run this in the plugin folder. It installs `vlucas/phpdotenv` for parsing
`.env`. **It's optional**: without `vendor/`, the plugin uses its own simple
`KEY=value` parser. Composer has nothing to do with getting the token.

### 3. Create the `.env` file

The plugin does **not** look in its own folder. Put `.env` in one of these
places (checked in this order):

1. **One level above the WordPress root**, the folder that _contains_ the
   WordPress install (recommended, since it can't be downloaded from the web).
2. **The WordPress root** itself, next to `wp-config.php`.

To use a different folder, add this to `wp-config.php`:

```php
define( 'CIF_VIEWER_ENV_DIR', '/path/to/folder/containing/env' );
```

Contents (the same as the standalone app's `.env`):

```
username=The Username
password=The Password
```

The account needs read access to the AMCSD dataset on ODR RRUFF.

### 4. Add the viewer to a page

Put this shortcode on a page:

```
[odr_rruff_cifviewer]
```

Then open the page with a record UUID:

```
https://your-site/your-page/?UUID=06672a8429fb856e198cda62bae9
```

The **AMCSD Record** section should say "Fetched successfully."

### Optional: fallback token

**Settings → CIF Viewer** has an "AMCSD API Token" field. It's only used when
no credentials are found in `.env`. Normally leave it empty.
