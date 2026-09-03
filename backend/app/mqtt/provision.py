"""Generate the broker's TLS material and credentials in-process.

This existed as a shell script the operator had to run on the docker host
before touching the UI, which is a strange thing to ask of a product whose
entire point is that configuring MQTT should not require knowing MQTT.
The camera's certificate requirements are the fiddliest part of the whole
setup and the least reasonable to make someone hand-assemble:

* the CA needs ``basicConstraints=CA:TRUE`` -- openssl's ``req -x509``
  omits it under LibreSSL, which the camera reports as "bad certificate"
* the leaf needs ``extendedKeyUsage=serverAuth``
* the leaf's SAN must contain the exact address in ``broker_host_port``,
  which is why changing the broker address invalidates every camera

Getting any of them wrong produces a TLS error in a container log the
operator has no reason to be reading.
"""

from __future__ import annotations

import base64
import hashlib
import ipaddress
import logging
import os
import secrets
from datetime import datetime, timedelta, timezone
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID


logger = logging.getLogger(__name__)

# ./mqtt on the host, mounted read-write. Certs land in certs/, the broker
# password file next to them, and both containers read from the same place.
MQTT_DIR = Path(os.environ.get("MQTT_DIR", "/app/mqtt-host"))
CERT_DIR = MQTT_DIR / "certs"
PASSWD_PATH = MQTT_DIR / "passwd"
CREDS_PATH = MQTT_DIR / "credentials.enc"
CA_PATH = CERT_DIR / "root_ca.pem"

CERT_YEARS = 10

# Mosquitto's password format is
#   <user>:$7$<iterations>$<salt-b64>$<hash-b64>
# PBKDF2-HMAC-SHA512, 64-byte derived key. The iteration count is read back
# out of the file, so this value only has to be consistent with itself.
PBKDF2_ITERATIONS = 101
SALT_BYTES = 12


def _is_ip(host: str) -> bool:
    try:
        ipaddress.ip_address(host)
        return True
    except ValueError:
        return False


def generate_certs(broker_host: str) -> dict[str, str]:
    """Create a CA and a server cert valid for ``broker_host``.

    Returns a summary; the CA text is what gets pushed to cameras.
    """
    CERT_DIR.mkdir(parents=True, exist_ok=True)
    now = datetime.now(timezone.utc)
    not_after = now + timedelta(days=365 * CERT_YEARS)

    ca_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    ca_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "vFusion-MQTT-RootCA")])
    ca_cert = (
        x509.CertificateBuilder()
        .subject_name(ca_name)
        .issuer_name(ca_name)
        .public_key(ca_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(minutes=5))
        .not_valid_after(not_after)
        .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
        .add_extension(
            x509.KeyUsage(
                digital_signature=False, content_commitment=False,
                key_encipherment=False, data_encipherment=False,
                key_agreement=False, key_cert_sign=True, crl_sign=True,
                encipher_only=False, decipher_only=False,
            ),
            critical=True,
        )
        .sign(ca_key, hashes.SHA256())
    )

    san = (
        x509.IPAddress(ipaddress.ip_address(broker_host))
        if _is_ip(broker_host)
        else x509.DNSName(broker_host)
    )
    srv_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    srv_cert = (
        x509.CertificateBuilder()
        .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, broker_host)]))
        .issuer_name(ca_name)
        .public_key(srv_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(minutes=5))
        .not_valid_after(not_after)
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(x509.SubjectAlternativeName([san]), critical=False)
        .add_extension(
            x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False
        )
        .sign(ca_key, hashes.SHA256())
    )

    ca_pem = ca_cert.public_bytes(serialization.Encoding.PEM).decode()
    srv_pem = srv_cert.public_bytes(serialization.Encoding.PEM).decode()
    srv_key_pem = srv_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.TraditionalOpenSSL,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode()

    CA_PATH.write_text(ca_pem)
    (CERT_DIR / "server.pem").write_text(srv_pem)
    # Leaf first, then the CA: nginx serves the chain, and a camera handed
    # only the leaf reports "unknown ca".
    (CERT_DIR / "fullchain.pem").write_text(srv_pem + ca_pem)
    key_path = CERT_DIR / "server.key"
    key_path.write_text(srv_key_pem)
    os.chmod(key_path, 0o600)

    logger.info("generated broker certs for %s", broker_host)
    return {
        "broker_host": broker_host,
        "san": ("IP:" if _is_ip(broker_host) else "DNS:") + broker_host,
        "expires": not_after.date().isoformat(),
        "ca_pem": ca_pem,
    }


def mosquitto_hash(password: str) -> str:
    salt = secrets.token_bytes(SALT_BYTES)
    digest = hashlib.pbkdf2_hmac("sha512", password.encode(), salt, PBKDF2_ITERATIONS, 64)
    return (
        f"$7${PBKDF2_ITERATIONS}$"
        f"{base64.b64encode(salt).decode()}${base64.b64encode(digest).decode()}"
    )


def write_password_file(username: str, password: str) -> None:
    """Write the broker password file in mosquitto's own hash format.

    No verification step is needed here: the vFusion backend authenticates
    against this same broker with these same credentials, so if the hash
    were malformed the ingest connection fails immediately and says so on
    the status endpoint.
    """
    MQTT_DIR.mkdir(parents=True, exist_ok=True)
    PASSWD_PATH.write_text(f"{username}:{mosquitto_hash(password)}\n")
    # Mosquitto refuses a world-readable password file.
    os.chmod(PASSWD_PATH, 0o600)


def save_credentials(username: str, password: str) -> None:
    """Keep the broker credentials so nothing has to be retyped.

    Mosquitto only ever stores a hash, but two other things need the
    plaintext: the ingest subscriber, and the config we push to cameras.
    Showing it once and asking the operator to paste it into .env made a
    generated secret their problem to carry, and losing the tab lost the
    broker. Encrypted with the same Fernet key as connection secrets, so
    it is no more exposed than a Verkada API key already is.
    """
    from app.crypto import encrypt_secret

    MQTT_DIR.mkdir(parents=True, exist_ok=True)
    CREDS_PATH.write_text(
        encrypt_secret({"username": username, "password": password})
    )
    os.chmod(CREDS_PATH, 0o600)


def load_credentials() -> dict[str, str] | None:
    """Stored broker credentials, or None if setup has not been run."""
    from app.crypto import decrypt_secret

    try:
        data = decrypt_secret(CREDS_PATH.read_text())
    except FileNotFoundError:
        return None
    except (OSError, ValueError) as e:
        logger.warning("could not read stored broker credentials: %s", e)
        return None
    if not isinstance(data, dict):
        return None
    username = data.get("username")
    password = data.get("password")
    if not username or not password:
        return None
    return {"username": str(username), "password": str(password)}


def clear() -> list[str]:
    """Remove all generated broker material. Returns what was deleted."""
    removed: list[str] = []
    for path in (CREDS_PATH, PASSWD_PATH, CA_PATH,
                 CERT_DIR / "server.pem", CERT_DIR / "server.key",
                 CERT_DIR / "fullchain.pem"):
        try:
            path.unlink()
            removed.append(path.name)
        except FileNotFoundError:
            continue
        except OSError as e:
            logger.warning("could not remove %s: %s", path, e)
    return removed


def generate_password(length: int = 24) -> str:
    return secrets.token_urlsafe(length)


def state() -> dict[str, object]:
    creds = load_credentials()
    return {
        "ca_present": CA_PATH.is_file(),
        "passwd_present": PASSWD_PATH.is_file(),
        "credentials_present": creds is not None,
        "username": creds["username"] if creds else None,
        "cert_dir": str(CERT_DIR),
    }
