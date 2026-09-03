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

import hashlib
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
# What a client displays in its camera list. It also seeds the hostname
# and the hardware scope, so it wants to be recognisable at a glance in
# a list of real cameras rather than descriptive of what it is.
MODEL = "vFusion Camera"
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


def operation(root: ET.Element) -> tuple[str, str]:
    """(local name, namespace) of the first element in the SOAP body.

    The namespace matters as well as the name. ``GetServiceCapabilities``
    exists in both the device and media WSDLs and means different things
    in each, so dispatching on the name alone answers one of them with
    the other's response — which a client reads as a malformed device
    rather than as a mistake worth reporting.
    """
    body = root.find(f"{{{SOAP_ENV}}}Body")
    if body is None:
        return "", ""
    for child in body:
        tag = child.tag
        if "}" in tag:
            ns, _, local = tag[1:].partition("}")
            return local, ns
        return tag, ""
    return "", ""


MEDIA_NS = "http://www.onvif.org/ver10/media/wsdl"


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


def device_service_capabilities() -> str:
    return (
        "<tds:GetServiceCapabilitiesResponse><tds:Capabilities>"
        '<tds:Network IPFilter="false" ZeroConfiguration="false" '
        'IPVersion6="false" DynDNS="false" HostnameFromDHCP="false"/>'
        '<tds:Security TLS1.0="false" TLS1.1="false" TLS1.2="false" '
        'OnboardKeyGeneration="false" AccessPolicyConfig="false" '
        'DefaultAccessPolicy="false" Dot1X="false" '
        'RemoteUserHandling="false" X.509Token="false" SAMLToken="false" '
        'KerberosToken="false" UsernameToken="true" HttpDigest="false" '
        'RELToken="false"/>'
        '<tds:System DiscoveryResolve="false" DiscoveryBye="false" '
        'RemoteDiscovery="false" SystemBackup="false" SystemLogging="false" '
        'FirmwareUpgrade="false" HttpFirmwareUpgrade="false" '
        'HttpSystemBackup="false" HttpSystemLogging="false" '
        'HttpSupportInformation="false"/>'
        "</tds:Capabilities></tds:GetServiceCapabilitiesResponse>"
    )


def mac_for(device_uuid: str) -> str:
    """A stable MAC, derived from the device UUID.

    There is no network card to read one off -- the device is a process
    sharing a container's stack. Clients display this and some key on it,
    so it has to be stable across restarts, which a real interface's
    address would not be. The 02 prefix marks it locally administered,
    which is what it is: made up, and honestly so.
    """
    digest = hashlib.sha256(device_uuid.encode()).digest()[:5]
    return "02:" + ":".join(f"{b:02x}" for b in digest)


def network_interfaces(state: dict[str, Any]) -> str:
    return (
        "<tds:GetNetworkInterfacesResponse>"
        '<tds:NetworkInterfaces token="eth0">'
        "<tt:Enabled>true</tt:Enabled>"
        "<tt:Info><tt:Name>eth0</tt:Name>"
        f"<tt:HwAddress>{mac_for(state.get('device_uuid', ''))}</tt:HwAddress>"
        "<tt:MTU>1500</tt:MTU></tt:Info>"
        "</tds:NetworkInterfaces>"
        "</tds:GetNetworkInterfacesResponse>"
    )


def discovery_mode() -> str:
    """NonDiscoverable, which is the truth.

    vFusion answers no WS-Discovery probes -- a bridge-networked
    container cannot receive them. A client that found this device did so
    because someone typed its address, and saying otherwise would invite
    it to expect a ProbeMatch that never comes.
    """
    return (
        "<tds:GetDiscoveryModeResponse>"
        "<tds:DiscoveryMode>NonDiscoverable</tds:DiscoveryMode>"
        "</tds:GetDiscoveryModeResponse>"
    )


def network_protocols() -> str:
    return (
        "<tds:GetNetworkProtocolsResponse>"
        "<tds:NetworkProtocols><tt:Name>HTTP</tt:Name>"
        "<tt:Enabled>true</tt:Enabled>"
        f"<tt:Port>{settings.ONVIF_PUBLIC_PORT}</tt:Port></tds:NetworkProtocols>"
        "<tds:NetworkProtocols><tt:Name>RTSP</tt:Name>"
        "<tt:Enabled>true</tt:Enabled>"
        f"<tt:Port>{settings.PUBLIC_PORT}</tt:Port></tds:NetworkProtocols>"
        "</tds:GetNetworkProtocolsResponse>"
    )


def dns() -> str:
    return (
        "<tds:GetDNSResponse><tds:DNSInformation>"
        "<tt:FromDHCP>false</tt:FromDHCP>"
        "</tds:DNSInformation></tds:GetDNSResponse>"
    )


def ntp() -> str:
    return (
        "<tds:GetNTPResponse><tds:NTPInformation>"
        "<tt:FromDHCP>false</tt:FromDHCP>"
        "</tds:NTPInformation></tds:GetNTPResponse>"
    )


def zero_configuration() -> str:
    return (
        "<tds:GetZeroConfigurationResponse><tds:ZeroConfiguration>"
        "<tt:InterfaceToken>eth0</tt:InterfaceToken>"
        "<tt:Enabled>false</tt:Enabled>"
        "</tds:ZeroConfiguration></tds:GetZeroConfigurationResponse>"
    )


def hostname() -> str:
    return (
        "<tds:GetHostnameResponse><tds:HostnameInformation>"
        "<tt:FromDHCP>false</tt:FromDHCP>"
        f"<tt:Name>{MODEL.replace(' ', '')}</tt:Name>"
        "</tds:HostnameInformation></tds:GetHostnameResponse>"
    )


def users(state: dict[str, Any]) -> str:
    """The one account, reported as Administrator.

    ONVIF grades accounts Administrator / Operator / User / Anonymous,
    and "User" means read-only. A client that intends to configure a
    device checks the level of the account it authenticated as and
    refuses to continue if it is too low -- which is what "insufficient
    credential permission" means, and it is a statement about this field
    rather than about anything the client was actually refused.

    There is only one account here and it can do everything this device
    supports, which is what Administrator says. It grants nothing: the
    device has no configuration to change, so every write operation is
    unimplemented regardless of who asks.
    """
    return (
        "<tds:GetUsersResponse><tds:User>"
        f"<tt:Username>{state.get('read_username', '')}</tt:Username>"
        "<tt:UserLevel>Administrator</tt:UserLevel>"
        "</tds:User></tds:GetUsersResponse>"
    )


# ---------------------------------------------------------------------------
# Media
# ---------------------------------------------------------------------------

def _kbps() -> str:
    return str(settings.AUDIO_BITRATE_KBPS)


def _multicast() -> str:
    """Required by the schema even for a device that does not multicast.

    tt:VideoEncoderConfiguration and tt:AudioEncoderConfiguration both
    declare Multicast as mandatory, immediately before SessionTimeout.
    Omitting it leaves the sequence short, and a client validating
    against the schema treats what follows as unexpected.
    """
    return (
        "<tt:Multicast><tt:Address><tt:Type>IPv4</tt:Type>"
        "<tt:IPv4Address>0.0.0.0</tt:IPv4Address></tt:Address>"
        "<tt:Port>0</tt:Port><tt:TTL>1</tt:TTL>"
        "<tt:AutoStart>false</tt:AutoStart></tt:Multicast>"
    )


def _audio_source_config(element: str = "tt:AudioSourceConfiguration") -> str:
    return (
        f'<{element} token="asc">'
        "<tt:Name>AudioSource</tt:Name><tt:UseCount>2</tt:UseCount>"
        "<tt:SourceToken>as0</tt:SourceToken>"
        f"</{element}>"
    )


def _audio_encoder_config(element: str = "tt:AudioEncoderConfiguration") -> str:
    """The audio half of a profile.

    Without it a client is told the device has no audio, and a client
    told that has no reason to set an audio track up -- however good the
    AAC in the RTSP stream is. The description decides whether the
    stream's audio is ever asked for.

    Bitrate is kbit/s and SampleRate is kHz here, which is neither unit
    they are stored in anywhere else in this codebase.
    """
    return (
        f'<{element} token="aec">'
        "<tt:Name>AudioEncoder</tt:Name><tt:UseCount>2</tt:UseCount>"
        "<tt:Encoding>G711</tt:Encoding>"
        f"<tt:Bitrate>{_kbps()}</tt:Bitrate>"
        f"<tt:SampleRate>{settings.AUDIO_RATE // 1000}</tt:SampleRate>"
        + _multicast()
        + "<tt:SessionTimeout>PT60S</tt:SessionTimeout>"
        f"</{element}>"
    )


def audio_sources() -> str:
    return (
        "<trt:GetAudioSourcesResponse>"
        '<trt:AudioSources token="as0">'
        f"<tt:Channels>{settings.AUDIO_CHANNELS}</tt:Channels>"
        "</trt:AudioSources>"
        "</trt:GetAudioSourcesResponse>"
    )


def audio_source_configurations() -> str:
    return (
        "<trt:GetAudioSourceConfigurationsResponse>"
        '<trt:Configurations token="asc">'
        "<tt:Name>AudioSource</tt:Name><tt:UseCount>2</tt:UseCount>"
        "<tt:SourceToken>as0</tt:SourceToken>"
        "</trt:Configurations>"
        "</trt:GetAudioSourceConfigurationsResponse>"
    )


def audio_encoder_configurations() -> str:
    return (
        "<trt:GetAudioEncoderConfigurationsResponse>"
        + _audio_encoder_config("trt:Configurations")
        + "</trt:GetAudioEncoderConfigurationsResponse>"
    )


def audio_encoder_configuration() -> str:
    return (
        "<trt:GetAudioEncoderConfigurationResponse>"
        + _audio_encoder_config("trt:Configuration")
        + "</trt:GetAudioEncoderConfigurationResponse>"
    )


def audio_encoder_options() -> str:
    """What the audio encoder could be set to: exactly what it is.

    Named in Verkada's own documentation as one of the calls a camera
    must implement before audio can be configured, alongside the getters
    and the setter. Offering a range would invite a client to pick
    something this device cannot produce.
    """
    return (
        "<trt:GetAudioEncoderConfigurationOptionsResponse><trt:Options>"
        "<tt:Options><tt:Encoding>G711</tt:Encoding>"
        f"<tt:BitrateList><tt:Items>{_kbps()}</tt:Items></tt:BitrateList>"
        "<tt:SampleRateList><tt:Items>"
        f"{settings.AUDIO_RATE // 1000}</tt:Items></tt:SampleRateList>"
        "</tt:Options>"
        "</trt:Options></trt:GetAudioEncoderConfigurationOptionsResponse>"
    )


def set_audio_encoder_configuration() -> str:
    """Accept the write and change nothing.

    Also named in Verkada's documentation as required. The device offers
    one encoder configuration and no alternatives, so any valid request
    asks for what is already in effect. Faulting would be truthful about
    this being read-only and would stop audio being configured at all,
    which is the opposite of useful.
    """
    return (
        "<trt:SetAudioEncoderConfigurationResponse>"
        "</trt:SetAudioEncoderConfigurationResponse>"
    )


def _video_source_config() -> str:
    return (
        '<tt:VideoSourceConfiguration token="vsc">'
        "<tt:Name>VideoSource</tt:Name><tt:UseCount>2</tt:UseCount>"
        "<tt:SourceToken>vs0</tt:SourceToken>"
        f'<tt:Bounds x="0" y="0" width="{settings.WIDTH}" '
        f'height="{settings.HEIGHT}"/>'
        "</tt:VideoSourceConfiguration>"
    )


def _video_encoder_config(
    token: str, name: str, width: int, height: int, bitrate: str
) -> str:
    # RateControl wants kbit/s as a number; the setting is an ffmpeg
    # string like "3000k".
    kbps = "".join(c for c in bitrate if c.isdigit()) or "0"
    return (
        f'<tt:VideoEncoderConfiguration token="vec_{token}">'
        f"<tt:Name>{name}</tt:Name><tt:UseCount>1</tt:UseCount>"
        "<tt:Encoding>H264</tt:Encoding>"
        f"<tt:Resolution><tt:Width>{width}</tt:Width>"
        f"<tt:Height>{height}</tt:Height></tt:Resolution>"
        "<tt:Quality>4</tt:Quality>"
        "<tt:RateControl>"
        f"<tt:FrameRateLimit>{settings.FPS}</tt:FrameRateLimit>"
        "<tt:EncodingInterval>1</tt:EncodingInterval>"
        f"<tt:BitrateLimit>{kbps}</tt:BitrateLimit>"
        "</tt:RateControl>"
        f"<tt:H264><tt:GovLength>{settings.FPS}</tt:GovLength>"
        "<tt:H264Profile>Main</tt:H264Profile></tt:H264>"
        + _multicast()
        + "<tt:SessionTimeout>PT60S</tt:SessionTimeout>"
        "</tt:VideoEncoderConfiguration>"
    )


def _profile(token: str, name: str, width: int, height: int, bitrate: str) -> str:
    """One profile, in the order the schema demands.

    tt:Profile is an xs:sequence, and its order is not decorative:

        Name, VideoSourceConfiguration, AudioSourceConfiguration,
        VideoEncoderConfiguration, AudioEncoderConfiguration, ...

    The audio configurations were appended after the video encoder,
    which reads fine and is wrong. A client built on generated bindings
    -- which is what a Command Connector uses -- silently drops elements
    that arrive out of sequence rather than complaining, so the profile
    parsed as video-only and the camera showed no audio at all. Nothing
    in the stream could have fixed that; the description is what decides
    whether audio is ever asked for.
    """
    return (
        f'<tt:Profiles token="{token}" fixed="true">'
        f"<tt:Name>{name}</tt:Name>"
        + _video_source_config()
        + _audio_source_config()
        + _video_encoder_config(token, name, width, height, bitrate)
        + _audio_encoder_config()
        + "</tt:Profiles>"
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


def media_service_capabilities() -> str:
    return (
        "<trt:GetServiceCapabilitiesResponse><trt:Capabilities "
        'SnapshotUri="true" Rotation="false" VideoSourceMode="false" '
        'OSD="false">'
        '<trt:ProfileCapabilities MaximumNumberOfProfiles="2"/>'
        '<trt:StreamingCapabilities RTPMulticast="false" '
        'RTP_TCP="true" RTP_RTSP_TCP="true" NonAggregateControl="false" '
        'NoRTSPStreaming="false"/>'
        "</trt:Capabilities></trt:GetServiceCapabilitiesResponse>"
    )


def _vec(token: str, name: str, width: int, height: int, bitrate: str) -> str:
    kbps = "".join(c for c in bitrate if c.isdigit()) or "0"
    return (
        f'<tt:Configurations token="vec_{token}">'
        f"<tt:Name>{name}</tt:Name><tt:UseCount>1</tt:UseCount>"
        "<tt:Encoding>H264</tt:Encoding>"
        f"<tt:Resolution><tt:Width>{width}</tt:Width>"
        f"<tt:Height>{height}</tt:Height></tt:Resolution>"
        "<tt:Quality>4</tt:Quality>"
        "<tt:RateControl>"
        f"<tt:FrameRateLimit>{settings.FPS}</tt:FrameRateLimit>"
        "<tt:EncodingInterval>1</tt:EncodingInterval>"
        f"<tt:BitrateLimit>{kbps}</tt:BitrateLimit></tt:RateControl>"
        f"<tt:H264><tt:GovLength>{settings.FPS}</tt:GovLength>"
        "<tt:H264Profile>Main</tt:H264Profile></tt:H264>"
        "<tt:SessionTimeout>PT60S</tt:SessionTimeout>"
        "</tt:Configurations>"
    )


def video_encoder_configurations() -> str:
    return (
        "<trt:GetVideoEncoderConfigurationsResponse>"
        + _vec("main", "MainStream", settings.WIDTH, settings.HEIGHT,
               settings.BITRATE)
        + _vec("sub", "SubStream", settings.SUB_WIDTH, settings.SUB_HEIGHT,
               settings.SUB_BITRATE)
        + "</trt:GetVideoEncoderConfigurationsResponse>"
    )


def video_encoder_configuration(token: str) -> str:
    body = (
        _vec("sub", "SubStream", settings.SUB_WIDTH, settings.SUB_HEIGHT,
             settings.SUB_BITRATE)
        if token == "sub"
        else _vec("main", "MainStream", settings.WIDTH, settings.HEIGHT,
                  settings.BITRATE)
    )
    # Same shape, different wrapper element name.
    body = body.replace("tt:Configurations", "trt:Configuration")
    return (
        f"<trt:GetVideoEncoderConfigurationResponse>{body}"
        "</trt:GetVideoEncoderConfigurationResponse>"
    )


def video_encoder_options() -> str:
    """What the encoder could be set to.

    Exactly what it is set to, and nothing else. The geometry is fixed
    for the life of the stream because it is baked into the SDP a client
    already negotiated, so advertising a range invites a client to ask
    for something this device would then have to refuse.
    """
    return (
        "<trt:GetVideoEncoderConfigurationOptionsResponse><trt:Options>"
        "<tt:QualityRange><tt:Min>1</tt:Min><tt:Max>6</tt:Max></tt:QualityRange>"
        "<tt:H264>"
        f"<tt:ResolutionsAvailable><tt:Width>{settings.WIDTH}</tt:Width>"
        f"<tt:Height>{settings.HEIGHT}</tt:Height></tt:ResolutionsAvailable>"
        f"<tt:ResolutionsAvailable><tt:Width>{settings.SUB_WIDTH}</tt:Width>"
        f"<tt:Height>{settings.SUB_HEIGHT}</tt:Height></tt:ResolutionsAvailable>"
        f"<tt:GovLengthRange><tt:Min>{settings.FPS}</tt:Min>"
        f"<tt:Max>{settings.FPS}</tt:Max></tt:GovLengthRange>"
        f"<tt:FrameRateRange><tt:Min>{settings.FPS}</tt:Min>"
        f"<tt:Max>{settings.FPS}</tt:Max></tt:FrameRateRange>"
        "<tt:EncodingIntervalRange><tt:Min>1</tt:Min><tt:Max>1</tt:Max>"
        "</tt:EncodingIntervalRange>"
        "<tt:H264ProfilesSupported>Main</tt:H264ProfilesSupported>"
        "</tt:H264></trt:Options>"
        "</trt:GetVideoEncoderConfigurationOptionsResponse>"
    )


def _vsc() -> str:
    return (
        '<tt:Configurations token="vsc">'
        "<tt:Name>VideoSource</tt:Name><tt:UseCount>2</tt:UseCount>"
        "<tt:SourceToken>vs0</tt:SourceToken>"
        f'<tt:Bounds x="0" y="0" width="{settings.WIDTH}" '
        f'height="{settings.HEIGHT}"/>'
        "</tt:Configurations>"
    )


def video_source_configurations() -> str:
    return (
        "<trt:GetVideoSourceConfigurationsResponse>"
        f"{_vsc()}</trt:GetVideoSourceConfigurationsResponse>"
    )


def video_source_configuration() -> str:
    body = _vsc().replace("tt:Configurations", "trt:Configuration")
    return (
        f"<trt:GetVideoSourceConfigurationResponse>{body}"
        "</trt:GetVideoSourceConfigurationResponse>"
    )


def empty(op: str, ns: str = "trt") -> str:
    """A well-formed empty answer.

    For the things this device genuinely has none of -- audio sources,
    audio encoders, metadata configurations. A fault would be wrong: the
    client asked a reasonable question and the honest answer is "none",
    not "that operation does not exist here".
    """
    return f"<{ns}:{op}Response></{ns}:{op}Response>"


def profile_token(root: ET.Element) -> str:
    """The ProfileToken a media call is asking about. Defaults to main."""
    for element in root.iter():
        if element.tag.rsplit("}", 1)[-1] == "ProfileToken":
            return (element.text or "").strip() or "main"
    return "main"
