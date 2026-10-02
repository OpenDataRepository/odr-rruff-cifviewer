<?php
/**
 * Plugin Name: ODR RRUFF CIF Viewer
 * Description: Reads a CIF and creates the AMC header
 * Version: 1.0.2
 * Author: Nathan
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'CIF_VIEWER_VERSION', '1.0.2' );
define( 'CIF_VIEWER_URL', plugin_dir_url( __FILE__ ) );
define( 'CIF_VIEWER_TOKEN_URL', 'https://www.rruff.net/odr_rruff/api/v4/token' );
define( 'CIF_VIEWER_RECORD_URL', 'https://www.rruff.net/odr_rruff/api/v4/dataset/record/' );

// Where to look for the .env holding the API credentials. It should live above
// the web root so it can't be downloaded; define CIF_VIEWER_ENV_DIR in
// wp-config.php to point somewhere else.
function cif_viewer_env_dirs() {
	if ( defined( 'CIF_VIEWER_ENV_DIR' ) ) {
		return array( CIF_VIEWER_ENV_DIR );
	}
	return array( dirname( ABSPATH ), ABSPATH );
}

// Directory path for messages, with the trailing slash dropped.
function cif_viewer_env_dir_label( $dir ) {
	return rtrim( $dir, '/\\' );
}

// Records why the server couldn't get a token (and logs it), so the shortcode
// can show the reason to admins instead of the page just failing with a 403.
function cif_viewer_token_error( $message = null ) {
	static $error = '';
	if ( null !== $message ) {
		$error = $message;
		error_log( 'CIF Viewer: ' . $message );
	}
	return $error;
}

// Path of the .env file that was found, or '' if none was.
function cif_viewer_env_file() {
	foreach ( cif_viewer_env_dirs() as $dir ) {
		$file = rtrim( $dir, '/\\' ) . '/.env';
		if ( is_readable( $file ) ) {
			return $file;
		}
	}
	return '';
}

// Returns the KEY => value pairs from the .env file itself, loaded once. They
// are kept apart from the server environment so a generic name like
// "username" can't pick up an unrelated system variable (on Windows,
// getenv('username') is the OS account name).
function cif_viewer_dotenv() {
	static $values = null;
	if ( null !== $values ) {
		return $values;
	}
	$values = array();

	$file = cif_viewer_env_file();
	if ( '' === $file ) {
		return $values;
	}

	if ( file_exists( __DIR__ . '/vendor/autoload.php' ) ) {
		require_once __DIR__ . '/vendor/autoload.php';
	}
	if ( class_exists( 'Dotenv\Dotenv' ) ) {
		$values = Dotenv\Dotenv::parse( file_get_contents( $file ) );
		return $values;
	}

	// No Composer install - parse the KEY=value lines ourselves.
	foreach ( file( $file, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES ) as $line ) {
		$line = trim( $line );
		if ( '' === $line || '#' === $line[0] || false === strpos( $line, '=' ) ) {
			continue;
		}
		list( $key, $value ) = array_map( 'trim', explode( '=', $line, 2 ) );
		if ( strlen( $value ) >= 2 && ( '"' === $value[0] || "'" === $value[0] ) && substr( $value, -1 ) === $value[0] ) {
			$value = substr( $value, 1, -1 );
		}
		$values[ $key ] = $value;
	}
	return $values;
}

// Server-level config (or a wp-config.php constant of the same name) wins over
// the .env file, so hosts can inject credentials without a file at all.
function cif_viewer_env( $key ) {
	if ( defined( $key ) ) {
		return constant( $key );
	}
	if ( isset( $_ENV[ $key ] ) ) {
		return $_ENV[ $key ];
	}
	if ( isset( $_SERVER[ $key ] ) ) {
		return $_SERVER[ $key ];
	}
	$value = getenv( $key );
	if ( false !== $value ) {
		return $value;
	}
	$dotenv = cif_viewer_dotenv();
	return isset( $dotenv[ $key ] ) ? $dotenv[ $key ] : '';
}

// Exchanges the .env credentials for an ODR API token server-to-server, so the
// secret never reaches the browser. The token is cached until shortly before
// it expires so page views don't each hit the token endpoint.
function cif_viewer_generate_token() {
	$cached = get_transient( 'cif_viewer_api_token_cache' );
	if ( $cached ) {
		return $cached;
	}

	// Also accept username/password, the names the standalone app's .env uses -
	// read from the .env file only, never the server environment.
	$client_id     = cif_viewer_env( 'API_CLIENT_ID' );
	$client_secret = cif_viewer_env( 'API_CLIENT_SECRET' );
	if ( '' === $client_id || '' === $client_secret ) {
		$dotenv        = cif_viewer_dotenv();
		$client_id     = isset( $dotenv['username'] ) ? $dotenv['username'] : '';
		$client_secret = isset( $dotenv['password'] ) ? $dotenv['password'] : '';
	}
	if ( '' === $client_id || '' === $client_secret ) {
		$env_file = cif_viewer_env_file();
		if ( '' === $env_file ) {
			cif_viewer_token_error( 'no .env file found - put it in one of: ' . implode( ', ', array_map( 'cif_viewer_env_dir_label', cif_viewer_env_dirs() ) ) . ' (not the plugin folder)' );
		} else {
			cif_viewer_token_error( 'found ' . $env_file . ' but it has no API_CLIENT_ID / API_CLIENT_SECRET (or username / password) values' );
		}
		return '';
	}

	$res = wp_remote_post(
		CIF_VIEWER_TOKEN_URL,
		array(
			'headers' => array( 'Content-Type' => 'application/json' ),
			'body'    => wp_json_encode( array( 'username' => $client_id, 'password' => $client_secret ) ),
			'timeout' => 15,
		)
	);
	if ( is_wp_error( $res ) ) {
		cif_viewer_token_error( 'token request to ' . CIF_VIEWER_TOKEN_URL . ' failed: ' . $res->get_error_message() );
		return '';
	}
	$code = wp_remote_retrieve_response_code( $res );
	$body = wp_remote_retrieve_body( $res );
	if ( $code < 200 || $code >= 300 ) {
		cif_viewer_token_error( 'token request was rejected with HTTP ' . $code . ' - check the credentials in the .env' );
		return '';
	}

	$data  = json_decode( $body, true );
	$token = is_array( $data ) ? ( $data['token'] ?? $data['access_token'] ?? $data['jwt'] ?? '' ) : trim( $body );
	if ( ! is_string( $token ) || '' === $token ) {
		cif_viewer_token_error( 'token response did not include a token' );
		return '';
	}

	// Cache until a minute before the JWT's own expiry, or 30 minutes if it
	// doesn't carry one.
	$ttl   = 30 * MINUTE_IN_SECONDS;
	$parts = explode( '.', $token );
	if ( 3 === count( $parts ) ) {
		$payload = json_decode( base64_decode( strtr( $parts[1], '-_', '+/' ) ), true );
		if ( isset( $payload['exp'] ) ) {
			$ttl = (int) $payload['exp'] - time() - MINUTE_IN_SECONDS;
		}
	}
	if ( $ttl > 0 ) {
		set_transient( 'cif_viewer_api_token_cache', $token, $ttl );
	}

	return $token;
}

function cif_viewer_register_settings() {
	register_setting(
		'cif_viewer_settings',
		'cif_viewer_api_token',
		array(
			'type'              => 'string',
			'sanitize_callback' => 'sanitize_text_field',
			'default'           => '',
		)
	);
}
add_action( 'admin_init', 'cif_viewer_register_settings' );

function cif_viewer_add_settings_page() {
	add_options_page( 'CIF Viewer', 'CIF Viewer', 'manage_options', 'cif-viewer', 'cif_viewer_render_settings_page' );
}
add_action( 'admin_menu', 'cif_viewer_add_settings_page' );

function cif_viewer_render_settings_page() {
	?>
	<div class="wrap">
		<h1>CIF Viewer Settings</h1>
		<form method="post" action="options.php">
			<?php settings_fields( 'cif_viewer_settings' ); ?>
			<table class="form-table">
				<tr>
					<th scope="row"><label for="cif_viewer_api_token">AMCSD API Token</label></th>
					<td>
						<input type="password" id="cif_viewer_api_token" name="cif_viewer_api_token" value="<?php echo esc_attr( get_option( 'cif_viewer_api_token', '' ) ); ?>" size="60">
						<p class="description">Optional fallback. Normally the token is generated from API_CLIENT_ID / API_CLIENT_SECRET in the .env file; this is only used when those aren't set.</p>
					</td>
				</tr>
			</table>
			<?php submit_button(); ?>
		</form>
	</div>
	<?php
}

// A fixed version string means the enqueued URL (style.css?ver=1.0.0) never
// changes between edits, so browsers/caching plugins keep serving the old file
// after every update - use the file's own mtime instead so it always bumps.
function cif_viewer_asset_version( $relative_path ) {
	$full_path = plugin_dir_path( __FILE__ ) . $relative_path;
	return file_exists( $full_path ) ? (string) filemtime( $full_path ) : CIF_VIEWER_VERSION;
}

function cif_viewer_register_assets() {
	wp_register_style( 'cif-viewer-style', CIF_VIEWER_URL . 'assets/style.css', array(), cif_viewer_asset_version( 'assets/style.css' ) );
	wp_register_script( 'cif-viewer-spacegroups', CIF_VIEWER_URL . 'assets/spacegroups.js', array(), cif_viewer_asset_version( 'assets/spacegroups.js' ), true );
	wp_register_script( 'cif-viewer-submit', CIF_VIEWER_URL . 'assets/submit.js', array(), cif_viewer_asset_version( 'assets/submit.js' ), true );
	wp_register_script( 'cif-viewer-app', CIF_VIEWER_URL . 'assets/app.js', array( 'cif-viewer-spacegroups', 'cif-viewer-submit' ), cif_viewer_asset_version( 'assets/app.js' ), true );
	wp_register_script( 'cif-viewer-amc2cif', CIF_VIEWER_URL . 'assets/amc2cif.js', array( 'cif-viewer-spacegroups' ), cif_viewer_asset_version( 'assets/amc2cif.js' ), true );
	wp_register_script( 'cif-viewer-amc2cif-ui', CIF_VIEWER_URL . 'assets/amc2cif-ui.js', array( 'cif-viewer-app', 'cif-viewer-amc2cif' ), cif_viewer_asset_version( 'assets/amc2cif-ui.js' ), true );
}
add_action( 'wp_enqueue_scripts', 'cif_viewer_register_assets' );

function cif_viewer_shortcode() {
	wp_enqueue_style( 'cif-viewer-style' );
	wp_enqueue_script( 'cif-viewer-spacegroups' );
	wp_enqueue_script( 'cif-viewer-submit' );
	wp_enqueue_script( 'cif-viewer-app' );
	wp_enqueue_script( 'cif-viewer-amc2cif' );
	wp_enqueue_script( 'cif-viewer-amc2cif-ui' );

	// Done here rather than at enqueue time so the token is only generated on
	// pages that actually show the viewer. The scripts load in the footer, so
	// this still lands before they're printed.
	$token        = cif_viewer_generate_token();
	$token_source = '' === $token ? '' : '.env';
	if ( '' === $token && '' !== get_option( 'cif_viewer_api_token', '' ) ) {
		$token        = get_option( 'cif_viewer_api_token', '' );
		$token_source = 'settings page';
	}
	$config = array(
		'token'     => $token,
		'recordUrl' => CIF_VIEWER_RECORD_URL,
	);
	// Only admins see why the token is missing; visitors get a generic message.
	if ( current_user_can( 'manage_options' ) ) {
		$config['tokenSource'] = $token_source;
		$config['tokenError']  = cif_viewer_token_error();
	}
	wp_localize_script( 'cif-viewer-app', 'odrRruffCifViewer', $config );

	ob_start();
	?>
	<div class="cif-viewer-app">
		<h1>CIF Converter</h1>

		<div id="panel">
			<label class="drop-zone">
			  <input type="file" id="fileInput" accept=".cif,text/plain">
			  <span class="drop-zone-prompt">Drag &amp; drop a .cif file here, or <span class="drop-zone-link">choose a file</span></span>
			  <span class="drop-zone-file"></span>
			</label>

			<div id="apiSection">
				<h3>AMCSD Record</h3>
				<div id="apiStatus"></div>
			</div>

			<div id="output">
				<h3>AMC Header</h3>
				<button id="copyHeaderBtn" class="cif-viewer-btn" type="button">Copy</button>
				<button id="sendHeaderBtn" hidden class="cif-viewer-btn" type="button">Send</button>
				<textarea id="amcHeaderOutput" readonly rows="1"></textarea>
				<p id="crystalSystemDisplay"></p>
				<div id="sendHeaderStatus" hidden></div>
			</div>

			<div id="metricTensorSection" hidden>
				<h3>G-Matrix</h3>
				<div id="metricTensorOutput"></div>
				<p id="cellVolumeDisplay"></p>
				<button id="sendGMatrixBtn" hidden class="cif-viewer-btn" type="button">Send</button>
				<div id="sendGMatrixStatus" hidden></div>
			</div>

			<div id="amcToCifSection">
				<h3>AMC &rarr; CIF</h3>
				<label class="drop-zone">
				  <input type="file" id="amcFileInput" accept=".amc,text/plain">
				  <span class="drop-zone-prompt">Drag &amp; drop a .amc file here, or <span class="drop-zone-link">choose a file</span></span>
				  <span class="drop-zone-file"></span>
				</label>
				<div id="amcToCifStatus"></div>
				<button id="copyAmcToCifBtn" class="cif-viewer-btn" type="button">Copy</button>
				<button id="sendAmcToCifBtn" hidden class="cif-viewer-btn" type="button">Send</button>
				<textarea id="amcToCifOutput" readonly rows="1"></textarea>
				<div id="sendAmcToCifStatus" hidden></div>
			</div>

			<div id="citationSection">
				<h3>Format Citation</h3>
				<p>Paste a citation like: Authors (Year) Title. Journal Volume, Pages</p>
				<textarea id="citationInput" rows="1"></textarea>
				<button id="formatCitationBtn" class="cif-viewer-btn" type="button">Format</button>
				<button id="copyCitationBtn" class="cif-viewer-btn" type="button">Copy</button>
				<div id="citationStatus"></div>
				<textarea id="citationOutput" readonly rows="1"></textarea>
			</div>
		</div>
	</div>
	<?php
	return ob_get_clean();
}
add_shortcode( 'odr_rruff_cifviewer', 'cif_viewer_shortcode' );
