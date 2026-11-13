use anyhow::{bail, Context, Result};
use sha2::{Digest, Sha256};
use windows_sys::Win32::{
    Foundation::{GetLastError, ERROR_NOT_FOUND},
    Security::Credentials::{
        CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE,
        CRED_TYPE_GENERIC,
    },
};

fn target(id: &str) -> Result<Vec<u16>> {
    if uuid::Uuid::parse_str(id).is_err() {
        bail!("连接 ID 不正确。");
    }
    let root = std::fs::canonicalize(crate::pool::home()).context("无法访问共享连接目录。");
    let root = root?.to_string_lossy().to_lowercase();
    let namespace = format!("{:x}", Sha256::digest(root.as_bytes()));
    Ok(format!("CodexPromptOptimizer/{namespace}/{id}")
        .encode_utf16()
        .chain(Some(0))
        .collect())
}
pub fn read(id: &str) -> Result<Option<String>> {
    let target = target(id)?;
    let mut credential = std::ptr::null_mut();
    unsafe {
        if CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut credential) == 0 {
            if GetLastError() == ERROR_NOT_FOUND {
                return Ok(None);
            }
            bail!("无法读取 Windows 共享凭据。");
        }
        if (*credential).CredentialBlob.is_null()
            || (*credential).CredentialBlobSize == 0
            || (*credential).CredentialBlobSize > 2560
        {
            CredFree(credential.cast());
            bail!("共享凭据格式不正确，请重新保存密钥。");
        }
        let bytes = std::slice::from_raw_parts(
            (*credential).CredentialBlob,
            (*credential).CredentialBlobSize as usize,
        );
        let value = std::str::from_utf8(bytes)
            .map(str::to_owned)
            .map_err(|_| anyhow::anyhow!("共享凭据编码不正确。"));
        CredFree(credential.cast());
        Ok(Some(value?))
    }
}
fn validate_size(value: &str) -> Result<()> {
    if value.is_empty() || value.len() > 2560 {
        bail!("密钥为空或超过 Windows 凭据存储的大小限制。");
    }
    Ok(())
}
pub fn validate_key(value: &str) -> Result<()> {
    validate_size(value)?;
    if value.chars().any(char::is_control) {
        bail!("API Key 不能包含换行或控制字符。");
    }
    Ok(())
}
pub fn write(id: &str, value: &str) -> Result<()> {
    validate_size(value)?;
    let mut target = target(id)?;
    let mut user: Vec<u16> = "Prompt Optimizer".encode_utf16().chain(Some(0)).collect();
    let mut bytes = value.as_bytes().to_vec();
    let mut credential: CREDENTIALW = unsafe { std::mem::zeroed() };
    credential.Type = CRED_TYPE_GENERIC;
    credential.TargetName = target.as_mut_ptr();
    credential.UserName = user.as_mut_ptr();
    credential.Persist = CRED_PERSIST_LOCAL_MACHINE;
    credential.CredentialBlobSize = bytes.len() as u32;
    credential.CredentialBlob = bytes.as_mut_ptr();
    let result = unsafe { CredWriteW(&credential, 0) };
    bytes.fill(0);
    if result == 0 {
        bail!("无法保存 Windows 共享凭据，原连接保留。");
    }
    Ok(())
}
pub fn remove(id: &str) -> Result<()> {
    let target = target(id)?;
    unsafe {
        if CredDeleteW(target.as_ptr(), CRED_TYPE_GENERIC, 0) == 0
            && GetLastError() != ERROR_NOT_FOUND
        {
            bail!("无法清除 Windows 共享凭据。");
        }
    }
    Ok(())
}
pub fn key(profile: &crate::config::Connection) -> Result<Option<String>> {
    if !profile.is_api() {
        return Ok(None);
    }
    if let Some(key) = read(&profile.id)? {
        return Ok(Some(key));
    }
    Ok(if profile.api_key_env.is_empty() {
        None
    } else {
        std::env::var(&profile.api_key_env)
            .ok()
            .filter(|key| !key.trim().is_empty())
    })
}
