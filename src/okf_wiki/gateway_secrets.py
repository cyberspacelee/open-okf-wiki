import ctypes
import ctypes.util
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any, Protocol

from .gateway_common import PROFILE_ID, GatewayError, atomic_write


class SecretBackend(Protocol):
    name: str

    def available(self) -> bool: ...

    def put(self, profile_id: str, secret: str) -> None: ...

    def get(self, profile_id: str) -> str: ...

    def delete(self, profile_id: str) -> None: ...


class LinuxSecretToolBackend:
    name = "linux-secret-tool"
    executable = "secret-tool"

    def available(self) -> bool:
        return shutil.which(self.executable) is not None

    def _run(self, command: list[str], *, secret: str | None = None) -> subprocess.CompletedProcess:
        try:
            return subprocess.run(
                command,
                input=secret,
                text=True,
                capture_output=True,
                check=False,
                timeout=10,
            )
        except (OSError, subprocess.TimeoutExpired) as error:
            raise GatewayError("operating-system credential store unavailable") from error

    def put(self, profile_id: str, secret: str) -> None:
        result = self._run(
            [
                self.executable,
                "store",
                "--label=OKF Wiki gateway",
                "service",
                "okf-wiki",
                "profile",
                profile_id,
            ],
            secret=secret,
        )
        if result.returncode:
            raise GatewayError("operating-system credential store unavailable")

    def get(self, profile_id: str) -> str:
        result = self._run(
            [self.executable, "lookup", "service", "okf-wiki", "profile", profile_id]
        )
        value = result.stdout.rstrip("\n")
        if result.returncode or not value:
            raise GatewayError("gateway credential unavailable")
        return value

    def delete(self, profile_id: str) -> None:
        self._run([self.executable, "clear", "service", "okf-wiki", "profile", profile_id])


class MacOSKeychainAPI(Protocol):
    def available(self) -> bool: ...

    def put(self, service: bytes, account: bytes, secret: bytes) -> None: ...

    def get(self, service: bytes, account: bytes) -> bytes | None: ...

    def delete(self, service: bytes, account: bytes) -> None: ...


class CtypesMacOSKeychain:
    """Small Security.framework adapter; only constructed on macOS in production."""

    item_not_found = -25300

    def __init__(self) -> None:
        self.security: Any | None = None
        self.core_foundation: Any | None = None
        if sys.platform != "darwin":
            return
        security_path = ctypes.util.find_library("Security")
        core_path = ctypes.util.find_library("CoreFoundation")
        if not security_path or not core_path:
            return
        try:
            self.security = ctypes.CDLL(security_path)
            self.core_foundation = ctypes.CDLL(core_path)
            self._configure()
        except AttributeError, OSError:
            self.security = None
            self.core_foundation = None

    def available(self) -> bool:
        return self.security is not None and self.core_foundation is not None

    def _configure(self) -> None:
        assert self.security is not None and self.core_foundation is not None
        void_pointer = ctypes.c_void_p
        uint32 = ctypes.c_uint32
        self.security.SecKeychainFindGenericPassword.argtypes = [
            void_pointer,
            uint32,
            ctypes.c_char_p,
            uint32,
            ctypes.c_char_p,
            ctypes.POINTER(uint32),
            ctypes.POINTER(void_pointer),
            ctypes.POINTER(void_pointer),
        ]
        self.security.SecKeychainFindGenericPassword.restype = ctypes.c_int32
        self.security.SecKeychainAddGenericPassword.argtypes = [
            void_pointer,
            uint32,
            ctypes.c_char_p,
            uint32,
            ctypes.c_char_p,
            uint32,
            void_pointer,
            ctypes.POINTER(void_pointer),
        ]
        self.security.SecKeychainAddGenericPassword.restype = ctypes.c_int32
        self.security.SecKeychainItemModifyAttributesAndData.argtypes = [
            void_pointer,
            void_pointer,
            uint32,
            void_pointer,
        ]
        self.security.SecKeychainItemModifyAttributesAndData.restype = ctypes.c_int32
        self.security.SecKeychainItemFreeContent.argtypes = [void_pointer, void_pointer]
        self.security.SecKeychainItemFreeContent.restype = ctypes.c_int32
        self.security.SecKeychainItemDelete.argtypes = [void_pointer]
        self.security.SecKeychainItemDelete.restype = ctypes.c_int32
        self.core_foundation.CFRelease.argtypes = [void_pointer]
        self.core_foundation.CFRelease.restype = None

    def _find(
        self, service: bytes, account: bytes
    ) -> tuple[int, ctypes.c_uint32, ctypes.c_void_p, ctypes.c_void_p]:
        if not self.available():
            raise GatewayError("macOS Keychain unavailable")
        assert self.security is not None
        length = ctypes.c_uint32()
        data = ctypes.c_void_p()
        item = ctypes.c_void_p()
        status = self.security.SecKeychainFindGenericPassword(
            None,
            len(service),
            service,
            len(account),
            account,
            ctypes.byref(length),
            ctypes.byref(data),
            ctypes.byref(item),
        )
        return status, length, data, item

    def _release(self, item: ctypes.c_void_p) -> None:
        if item.value and self.core_foundation is not None:
            self.core_foundation.CFRelease(item)

    def get(self, service: bytes, account: bytes) -> bytes | None:
        status, length, data, item = self._find(service, account)
        if status == self.item_not_found:
            return None
        if status != 0:
            raise GatewayError("macOS Keychain lookup failed")
        try:
            return ctypes.string_at(data, length.value)
        finally:
            assert self.security is not None
            self.security.SecKeychainItemFreeContent(None, data)
            self._release(item)

    def put(self, service: bytes, account: bytes, secret: bytes) -> None:
        status, _length, data, item = self._find(service, account)
        secret_buffer = ctypes.create_string_buffer(secret)
        try:
            assert self.security is not None
            if status == 0:
                self.security.SecKeychainItemFreeContent(None, data)
                result = self.security.SecKeychainItemModifyAttributesAndData(
                    item,
                    None,
                    len(secret),
                    ctypes.cast(secret_buffer, ctypes.c_void_p),
                )
            elif status == self.item_not_found:
                item = ctypes.c_void_p()
                result = self.security.SecKeychainAddGenericPassword(
                    None,
                    len(service),
                    service,
                    len(account),
                    account,
                    len(secret),
                    ctypes.cast(secret_buffer, ctypes.c_void_p),
                    ctypes.byref(item),
                )
            else:
                raise GatewayError("macOS Keychain lookup failed")
            if result != 0:
                raise GatewayError("macOS Keychain update failed")
        finally:
            ctypes.memset(secret_buffer, 0, len(secret_buffer))
            self._release(item)

    def delete(self, service: bytes, account: bytes) -> None:
        status, _length, data, item = self._find(service, account)
        if status == self.item_not_found:
            return
        if status != 0:
            self._release(item)
            raise GatewayError("macOS Keychain lookup failed")
        try:
            assert self.security is not None
            self.security.SecKeychainItemFreeContent(None, data)
            if self.security.SecKeychainItemDelete(item) != 0:
                raise GatewayError("macOS Keychain delete failed")
        finally:
            self._release(item)


class MacOSSecurityBackend:
    """Uses the current user's default macOS Keychain; the OS may show an access prompt."""

    name = "macos-keychain"
    service = b"okf-wiki-gateway"

    def __init__(self, api: MacOSKeychainAPI | None = None) -> None:
        self.api = api or CtypesMacOSKeychain()

    def available(self) -> bool:
        return self.api.available()

    def put(self, profile_id: str, secret: str) -> None:
        self.api.put(self.service, profile_id.encode(), secret.encode())

    def get(self, profile_id: str) -> str:
        value = self.api.get(self.service, profile_id.encode())
        if not value:
            raise GatewayError("gateway credential unavailable")
        try:
            return value.decode()
        except UnicodeDecodeError as error:
            raise GatewayError("gateway credential is not valid UTF-8") from error

    def delete(self, profile_id: str) -> None:
        self.api.delete(self.service, profile_id.encode())


class WindowsCredentialAPI(Protocol):
    def available(self) -> bool: ...

    def put(self, target: str, secret: bytes) -> None: ...

    def get(self, target: str) -> bytes | None: ...

    def delete(self, target: str) -> None: ...


class _WindowsFileTime(ctypes.Structure):
    _fields_ = [("low", ctypes.c_uint32), ("high", ctypes.c_uint32)]


class _WindowsCredential(ctypes.Structure):
    _fields_ = [
        ("flags", ctypes.c_uint32),
        ("type", ctypes.c_uint32),
        ("target_name", ctypes.c_wchar_p),
        ("comment", ctypes.c_wchar_p),
        ("last_written", _WindowsFileTime),
        ("credential_blob_size", ctypes.c_uint32),
        ("credential_blob", ctypes.POINTER(ctypes.c_ubyte)),
        ("persist", ctypes.c_uint32),
        ("attribute_count", ctypes.c_uint32),
        ("attributes", ctypes.c_void_p),
        ("target_alias", ctypes.c_wchar_p),
        ("user_name", ctypes.c_wchar_p),
    ]


class CtypesWindowsCredentialManager:
    credential_type_generic = 1
    persist_local_machine = 2
    error_not_found = 1168

    def __init__(self) -> None:
        self.advapi32: Any | None = None
        if sys.platform != "win32":
            return
        try:
            loader = getattr(ctypes, "WinDLL")
            self.advapi32 = loader("Advapi32", use_last_error=True)
            self._configure()
        except AttributeError, OSError:
            self.advapi32 = None

    def available(self) -> bool:
        return self.advapi32 is not None

    def _configure(self) -> None:
        assert self.advapi32 is not None
        credential_pointer = ctypes.POINTER(_WindowsCredential)
        self.advapi32.CredWriteW.argtypes = [credential_pointer, ctypes.c_uint32]
        self.advapi32.CredWriteW.restype = ctypes.c_int
        self.advapi32.CredReadW.argtypes = [
            ctypes.c_wchar_p,
            ctypes.c_uint32,
            ctypes.c_uint32,
            ctypes.POINTER(credential_pointer),
        ]
        self.advapi32.CredReadW.restype = ctypes.c_int
        self.advapi32.CredDeleteW.argtypes = [
            ctypes.c_wchar_p,
            ctypes.c_uint32,
            ctypes.c_uint32,
        ]
        self.advapi32.CredDeleteW.restype = ctypes.c_int
        self.advapi32.CredFree.argtypes = [ctypes.c_void_p]
        self.advapi32.CredFree.restype = None

    @staticmethod
    def _last_error() -> int:
        return int(getattr(ctypes, "get_last_error")())

    def put(self, target: str, secret: bytes) -> None:
        if not self.available():
            raise GatewayError("Windows Credential Manager unavailable")
        assert self.advapi32 is not None
        secret_buffer = ctypes.create_string_buffer(secret)
        credential = _WindowsCredential(
            type=self.credential_type_generic,
            target_name=target,
            credential_blob_size=len(secret),
            credential_blob=ctypes.cast(
                secret_buffer,
                ctypes.POINTER(ctypes.c_ubyte),
            ),
            persist=self.persist_local_machine,
            user_name=target,
        )
        try:
            if not self.advapi32.CredWriteW(ctypes.byref(credential), 0):
                raise GatewayError("Windows Credential Manager update failed")
        finally:
            ctypes.memset(secret_buffer, 0, len(secret_buffer))

    def get(self, target: str) -> bytes | None:
        if not self.available():
            raise GatewayError("Windows Credential Manager unavailable")
        assert self.advapi32 is not None
        pointer = ctypes.POINTER(_WindowsCredential)()
        if not self.advapi32.CredReadW(
            target,
            self.credential_type_generic,
            0,
            ctypes.byref(pointer),
        ):
            if self._last_error() == self.error_not_found:
                return None
            raise GatewayError("Windows Credential Manager lookup failed")
        try:
            credential = pointer.contents
            return ctypes.string_at(
                credential.credential_blob,
                credential.credential_blob_size,
            )
        finally:
            self.advapi32.CredFree(pointer)

    def delete(self, target: str) -> None:
        if not self.available():
            raise GatewayError("Windows Credential Manager unavailable")
        assert self.advapi32 is not None
        if self.advapi32.CredDeleteW(target, self.credential_type_generic, 0):
            return
        if self._last_error() != self.error_not_found:
            raise GatewayError("Windows Credential Manager delete failed")


class WindowsCredentialBackend:
    name = "windows-credential-manager"
    target_prefix = "okf-wiki-gateway:"

    def __init__(self, api: WindowsCredentialAPI | None = None) -> None:
        self.api = api or CtypesWindowsCredentialManager()

    def available(self) -> bool:
        return self.api.available()

    def put(self, profile_id: str, secret: str) -> None:
        self.api.put(self.target_prefix + profile_id, secret.encode())

    def get(self, profile_id: str) -> str:
        value = self.api.get(self.target_prefix + profile_id)
        if not value:
            raise GatewayError("gateway credential unavailable")
        try:
            return value.decode()
        except UnicodeDecodeError as error:
            raise GatewayError("gateway credential is not valid UTF-8") from error

    def delete(self, profile_id: str) -> None:
        self.api.delete(self.target_prefix + profile_id)


class LocalFileSecretBackend:
    name = "local-file-0600"

    def __init__(self, root: Path) -> None:
        self.root = root.resolve()

    def available(self) -> bool:
        return True

    def _path(self, profile_id: str) -> Path:
        if PROFILE_ID.fullmatch(profile_id) is None:
            raise GatewayError("invalid Gateway Profile ID")
        return self.root / f"{profile_id}.secret"

    def put(self, profile_id: str, secret: str) -> None:
        path = self._path(profile_id)
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.parent.chmod(0o700)
            atomic_write(path, secret, 0o600)
        except OSError as error:
            raise GatewayError("cannot write the restricted local credential store") from error

    def get(self, profile_id: str) -> str:
        path = self._path(profile_id)
        try:
            if path.parent.stat().st_mode & 0o077:
                raise GatewayError("local credential directory permissions are too broad")
            mode = path.stat().st_mode
            if mode & (stat_bits := 0o077):
                raise GatewayError(
                    f"local credential permissions are too broad ({oct(mode & stat_bits)})"
                )
            value = path.read_text(encoding="utf-8")
        except OSError as error:
            raise GatewayError("gateway credential unavailable") from error
        if not value:
            raise GatewayError("gateway credential unavailable")
        return value

    def delete(self, profile_id: str) -> None:
        try:
            self._path(profile_id).unlink(missing_ok=True)
        except OSError as error:
            raise GatewayError("cannot remove the local credential") from error


class SecretStore:
    def __init__(self, *, primary: SecretBackend | None, fallback: SecretBackend) -> None:
        self.primary = primary
        self.fallback = fallback

    def put(self, profile_id: str, secret: str) -> str:
        if not secret:
            raise GatewayError("credential must not be empty")
        if self.primary is not None and self.primary.available():
            try:
                self.primary.put(profile_id, secret)
                return self.primary.name
            except GatewayError:
                pass
        self.fallback.put(profile_id, secret)
        return self.fallback.name

    def get(self, profile_id: str, backend: str) -> str:
        candidate = self._backend(backend)
        if candidate is not None:
            return candidate.get(profile_id)
        raise GatewayError("gateway credential unavailable")

    def restore(self, profile_id: str, secret: str, backend: str) -> None:
        candidate = self._backend(backend)
        if candidate is not None:
            candidate.put(profile_id, secret)
            return
        raise GatewayError("cannot restore the previous gateway credential")

    def delete(self, profile_id: str, backend: str | None) -> None:
        candidate = self._backend(backend)
        if candidate is not None:
            candidate.delete(profile_id)

    def _backend(self, backend: str | None) -> SecretBackend | None:
        for candidate in (self.primary, self.fallback):
            if candidate is not None and candidate.name == backend and candidate.available():
                return candidate
        return None


def system_secret_backend() -> SecretBackend | None:
    if sys.platform == "darwin":
        return MacOSSecurityBackend()
    if sys.platform == "win32":
        return WindowsCredentialBackend()
    if sys.platform.startswith("linux"):
        return LinuxSecretToolBackend()
    return None
