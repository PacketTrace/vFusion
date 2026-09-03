"""The ONVIF device, as far as a Command Connector is concerned.

Enough of Profile S for a client to find the streams and describe them:
device management, and media. Not a general ONVIF implementation -- there
is no PTZ, no audio, no analytics, no imaging, because the device behind
this is one fixed video source and claiming otherwise invites clients to
call things that do not exist.

Responses are XML templates rather than a generated binding. There is no
serious ONVIF *server* library for Python (onvif-zeep and its relatives
are clients), and the operations a streaming client actually calls are
few, static, and driven entirely by settings that are already fixed.
Generating them from the WSDL would be more machinery than the thing it
generates.

Namespaces are load-bearing. Clients match on the fully-qualified
element name, so a response in the right shape under the wrong namespace
parses as an empty result rather than an error -- which shows up as "the
camera has no profiles" and sends you looking in the wrong place.
"""

from __future__ import annotations

from typing import Any
from xml.etree import ElementTree as ET

from app.rtsp import settings


SOAP_ENV = "http://www.w3.org/2003/05/soap-envelope"

NS = (
    'xmlns:s="http://www.w3.org/2003/05/soap-envelope" '
    'xmlns:tds="http://www.onvif.org/ver10/device/wsdl" '
    'xmlns:trt="http://www.onvif.org/ver10/media/wsdl" '
    'xmlns:tt="http://www.onvif.org/ver10/schema"'
)

MANUFACTURER = "vFusion"
MODEL = "Virtual Camera"
FIRMWARE = "1.0"


def envelope(body: str) -> str:
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        f"<s:Envelope {NS}><s:Body>{body}</s:Body></s:Envelope>"
    )


def fault(reason: str, subcode: str = "ter:InvalidArgVal") -> str:
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        f'<s:Envelope {NS} xmlns:ter="http://www.onvif.org/ver10/error">'
        "<s:Body><s:Fault>"
        "<s:Code><s:Value>s:Sender</s:Value>"
        f"<s:Subcode><s:Value>{subcode}</s:Value></s:Subcode></s:Code>"
        f'<s:Reason><s:Text xml:lang="en">{reason}</s:Text></s:Reason>'
        "</s:Fault></s:Body></s:Envelope>"
    )


def unauthorized() -> str:
    return fault("Sender not authorized", "ter:NotAuthorized")


def operation(root: ET.Element) -> str:
    """The local name of the first element in the SOAP body."""
    body = root.find(f"{{{SOAP_ENV}}}Body")
    if body is None:
        return ""
    for child in body:
        tag = child.tag
        return tag.rsplit("}", 1)[-1] if "}" in tag else tag
    return ""


# ---------------------------------------------------------------------------
# Device management
# ---------------------------------------------------------------------------

def device_information(state: dict[str, Any]) -> str:
    # The serial doubles as the stable identity a client keys the device
    # on, so it is the same UUID used in the endpoint reference.
    return (
        "<tds:GetDeviceInformationResponse>"
        f"<tds:Manufacturer>{MANUFACTURER}</tds:Manufacturer>"
        f"<tds:Model>{MODEL}</tds:Model>"
        f"<tds:FirmwareVersion>{FIRMWARE}</tds:FirmwareVersion>"
        f"<tds:SerialNumber>{state.get('device_uuid', '')}</tds:SerialNumber>"
        f"<tds:HardwareId>{MODEL}</tds:HardwareId>"
        "</tds:GetDeviceInformationResponse>"
    )


def system_date_and_time(now: Any) -> str:
    """UTC only, and explicitly not from a timezone the device invented.

    Answered without authentication on purpose -- see auth.py. A client
    uses this to work out how far its clock is from the device's before
    it can build a digest the device will accept.
    """
    return (
        "<tds:GetSystemDateAndTimeResponse><tds:SystemDateAndTime>"
        "<tt:DateTimeType>NTP</tt:DateTimeType>"
        "<tt:DaylightSavings>false</tt:DaylightSavings>"
        "<tt:TimeZone><tt:TZ>UTC0</tt:TZ></tt:TimeZone>"
        "<tt:UTCDateTime>"
        f"<tt:Time><tt:Hour>{now.hour}</tt:Hour>"
        f"<tt:Minute>{now.minute}</tt:Minute>"
        f"<tt:Second>{now.second}</tt:Second></tt:Time>"
        f"<tt:Date><tt:Year>{now.year}</tt:Year>"
        f"<tt:Month>{now.month}</tt:Month>"
        f"<tt:Day>{now.day}</tt:Day></tt:Date>"
        "</tt:UTCDateTime>"
        "</tds:SystemDateAndTime></tds:GetSystemDateAndTimeResponse>"
    )


def capabilities(base: str) -> str:
    return (
        "<tds:GetCapabilitiesResponse><tds:Capabilities>"
        f"<tt:Device><tt:XAddr>{base}/onvif/device_service</tt:XAddr>"
        "<tt:System><tt:DiscoveryResolve>false</tt:DiscoveryResolve>"
        "<tt:DiscoveryBye>false</tt:DiscoveryBye>"
        "<tt:RemoteDiscovery>false</tt:RemoteDiscovery>"
        "<tt:SystemBackup>false</tt:SystemBackup>"
        "<tt:SystemLogging>false</tt:SystemLogging>"
        "<tt:FirmwareUpgrade>false</tt:FirmwareUpgrade>"
        "</tt:System></tt:Device>"
        f"<tt:Media><tt:XAddr>{base}/onvif/media_service</tt:XAddr>"
        "<tt:StreamingCapabilities>"
        "<tt:RTPMulticast>false</tt:RTPMulticast>"
        "<tt:RTP_TCP>true</tt:RTP_TCP>"
        "<tt:RTP_RTSP_TCP>true</tt:RTP_RTSP_TCP>"
        "</tt:StreamingCapabilities></tt:Media>"
        "</tds:Capabilities></tds:GetCapabilitiesResponse>"
    )


def services(base: str) -> str:
    return (
        "<tds:GetServicesResponse>"
        "<tds:Service>"
        "<tds:Namespace>http://www.onvif.org/ver10/device/wsdl</tds:Namespace>"
        f"<tds:XAddr>{base}/onvif/device_service</tds:XAddr>"
        "<tds:Version><tt:Major>2</tt:Major><tt:Minor>5</tt:Minor></tds:Version>"
        "</tds:Service>"
        "<tds:Service>"
        "<tds:Namespace>http://www.onvif.org/ver10/media/wsdl</tds:Namespace>"
        f"<tds:XAddr>{base}/onvif/media_service</tds:XAddr>"
        "<tds:Version><tt:Major>2</tt:Major><tt:Minor>5</tt:Minor></tds:Version>"
        "</tds:Service>"
        "</tds:GetServicesResponse>"
    )


def scopes() -> str:
    values = [
        "onvif://www.onvif.org/type/video_encoder",
        "onvif://www.onvif.org/Profile/Streaming",
        f"onvif://www.onvif.org/name/{MANUFACTURER}",
        f"onvif://www.onvif.org/hardware/{MODEL.replace(' ', '_')}",
    ]
    items = "".join(
        "<tds:Scopes><tt:ScopeDef>Fixed</tt:ScopeDef>"
        f"<tt:ScopeItem>{v}</tt:ScopeItem></tds:Scopes>"
        for v in values
    )
    return f"<tds:GetScopesResponse>{items}</tds:GetScopesResponse>"


def users(state: dict[str, Any]) -> str:
    return (
        "<tds:GetUsersResponse><tds:User>"
        f"<tt:Username>{state.get('read_username', '')}</tt:Username>"
        "<tt:UserLevel>User</tt:UserLevel>"
        "</tds:User></tds:GetUsersResponse>"
    )


# ---------------------------------------------------------------------------
# Media
# ---------------------------------------------------------------------------

def _profile(token: str, name: str, width: int, height: int, bitrate: str) -> str:
    # RateControl wants kbit/s as a number; the setting is an ffmpeg
    # string like "3000k".
    kbps = "".join(c for c in bitrate if c.isdigit()) or "0"
    return (
        f'<tt:Profiles token="{token}" fixed="true">'
        f"<tt:Name>{name}</tt:Name>"
        f'<tt:VideoSourceConfiguration token="vsc">'
        "<tt:Name>VideoSource</tt:Name><tt:UseCount>2</tt:UseCount>"
        "<tt:SourceToken>vs0</tt:SourceToken>"
        f'<tt:Bounds x="0" y="0" width="{settings.WIDTH}" '
        f'height="{settings.HEIGHT}"/>'
        "</tt:VideoSourceConfiguration>"
        f'<tt:VideoEncoderConfiguration token="vec_{token}">'
        f"<tt:Name>{name}</tt:Name><tt:UseCount>1</tt:UseCount>"
        "<tt:Encoding>H264</tt:Encoding>"
        f'<tt:Resolution><tt:Width>{width}</tt:Width>'
        f"<tt:Height>{height}</tt:Height></tt:Resolution>"
        "<tt:Quality>4</tt:Quality>"
        "<tt:RateControl>"
        f"<tt:FrameRateLimit>{settings.FPS}</tt:FrameRateLimit>"
        "<tt:EncodingInterval>1</tt:EncodingInterval>"
        f"<tt:BitrateLimit>{kbps}</tt:BitrateLimit>"
        "</tt:RateControl>"
        "<tt:H264><tt:GovLength>"
        f"{settings.FPS}</tt:GovLength>"
        "<tt:H264Profile>Main</tt:H264Profile></tt:H264>"
        "<tt:SessionTimeout>PT60S</tt:SessionTimeout>"
        "</tt:VideoEncoderConfiguration>"
        "</tt:Profiles>"
    )


def profiles(state: dict[str, Any]) -> str:
    main = _profile(
        "main", "MainStream", settings.WIDTH, settings.HEIGHT, settings.BITRATE
    )
    sub = _profile(
        "sub", "SubStream", settings.SUB_WIDTH, settings.SUB_HEIGHT,
        settings.SUB_BITRATE,
    )
    return f"<trt:GetProfilesResponse>{main}{sub}</trt:GetProfilesResponse>"


def profile(state: dict[str, Any], token: str) -> str:
    body = (
        _profile("sub", "SubStream", settings.SUB_WIDTH, settings.SUB_HEIGHT,
                 settings.SUB_BITRATE)
        if token == "sub"
        else _profile("main", "MainStream", settings.WIDTH, settings.HEIGHT,
                      settings.BITRATE)
    )
    return f"<trt:GetProfileResponse>{body}</trt:GetProfileResponse>"


def video_sources() -> str:
    return (
        "<trt:GetVideoSourcesResponse>"
        f'<trt:VideoSources token="vs0">'
        f"<tt:Framerate>{settings.FPS}</tt:Framerate>"
        f'<tt:Resolution><tt:Width>{settings.WIDTH}</tt:Width>'
        f"<tt:Height>{settings.HEIGHT}</tt:Height></tt:Resolution>"
        "</trt:VideoSources>"
        "</trt:GetVideoSourcesResponse>"
    )


def stream_uri(state: dict[str, Any], token: str) -> str:
    stream = (
        settings.sub_stream(state) if token == "sub" else state.get("stream")
    )
    uri = settings.stream_url(state, stream)
    return (
        "<trt:GetStreamUriResponse><trt:MediaUri>"
        f"<tt:Uri>{uri}</tt:Uri>"
        "<tt:InvalidAfterConnect>false</tt:InvalidAfterConnect>"
        "<tt:InvalidAfterReboot>false</tt:InvalidAfterReboot>"
        "<tt:Timeout>PT60S</tt:Timeout>"
        "</trt:MediaUri></trt:GetStreamUriResponse>"
    )


def snapshot_uri(state: dict[str, Any]) -> str:
    host = str(state.get("advertise_host") or "").strip()
    uri = (
        f"http://{host}:{settings.ONVIF_PUBLIC_PORT}/onvif/snapshot.jpg"
        if host
        else ""
    )
    return (
        "<trt:GetSnapshotUriResponse><trt:MediaUri>"
        f"<tt:Uri>{uri}</tt:Uri>"
        "<tt:InvalidAfterConnect>false</tt:InvalidAfterConnect>"
        "<tt:InvalidAfterReboot>false</tt:InvalidAfterReboot>"
        "<tt:Timeout>PT60S</tt:Timeout>"
        "</trt:MediaUri></trt:GetSnapshotUriResponse>"
    )


def profile_token(root: ET.Element) -> str:
    """The ProfileToken a media call is asking about. Defaults to main."""
    for element in root.iter():
        if element.tag.rsplit("}", 1)[-1] == "ProfileToken":
            return (element.text or "").strip() or "main"
    return "main"
