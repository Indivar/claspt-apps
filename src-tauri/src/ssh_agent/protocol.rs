// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! The SSH agent wire protocol (draft-miller-ssh-agent), the two requests a
//! signing-only agent needs, and framing. Pure functions, no I/O except the
//! async frame reader.

use tokio::io::{AsyncRead, AsyncReadExt};

pub const SSH_AGENT_FAILURE: u8 = 5;
pub const SSH_AGENTC_REQUEST_IDENTITIES: u8 = 11;
pub const SSH_AGENT_IDENTITIES_ANSWER: u8 = 12;
pub const SSH_AGENTC_SIGN_REQUEST: u8 = 13;
pub const SSH_AGENT_SIGN_RESPONSE: u8 = 14;

/// Sign-request flags asking for an RSA signature with a SHA-2 hash.
pub const SSH_AGENT_RSA_SHA2_256: u32 = 2;
pub const SSH_AGENT_RSA_SHA2_512: u32 = 4;

/// Largest message accepted. Agent messages are small; a bigger one is a
/// client that is confused or hostile, and refusing it costs nothing.
pub const MAX_MESSAGE: usize = 256 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Request {
    RequestIdentities,
    Sign {
        key_blob: Vec<u8>,
        data: Vec<u8>,
        flags: u32,
    },
    /// Anything else (add, remove, lock, extensions): answered with failure.
    Unsupported(u8),
}

struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn u32(&mut self) -> Result<u32, String> {
        let end = self.pos + 4;
        let bytes = self.buf.get(self.pos..end).ok_or("message truncated")?;
        self.pos = end;
        Ok(u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
    }

    fn string(&mut self) -> Result<&'a [u8], String> {
        let len = self.u32()? as usize;
        let end = self.pos.checked_add(len).ok_or("length overflow")?;
        let bytes = self.buf.get(self.pos..end).ok_or("message truncated")?;
        self.pos = end;
        Ok(bytes)
    }
}

pub fn parse_request(msg: &[u8]) -> Result<Request, String> {
    let (&kind, rest) = msg.split_first().ok_or("empty message")?;
    match kind {
        SSH_AGENTC_REQUEST_IDENTITIES => Ok(Request::RequestIdentities),
        SSH_AGENTC_SIGN_REQUEST => {
            let mut r = Reader { buf: rest, pos: 0 };
            let key_blob = r.string()?.to_vec();
            let data = r.string()?.to_vec();
            let flags = r.u32()?;
            Ok(Request::Sign {
                key_blob,
                data,
                flags,
            })
        }
        other => Ok(Request::Unsupported(other)),
    }
}

fn put_string(out: &mut Vec<u8>, bytes: &[u8]) {
    out.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
    out.extend_from_slice(bytes);
}

/// `SSH_AGENT_IDENTITIES_ANSWER` for (public key blob, comment) pairs.
pub fn identities_answer(keys: &[(Vec<u8>, String)]) -> Vec<u8> {
    let mut out = vec![SSH_AGENT_IDENTITIES_ANSWER];
    out.extend_from_slice(&(keys.len() as u32).to_be_bytes());
    for (blob, comment) in keys {
        put_string(&mut out, blob);
        put_string(&mut out, comment.as_bytes());
    }
    out
}

/// `SSH_AGENT_SIGN_RESPONSE` carrying an already wire-encoded signature.
pub fn sign_response(signature: &[u8]) -> Vec<u8> {
    let mut out = vec![SSH_AGENT_SIGN_RESPONSE];
    put_string(&mut out, signature);
    out
}

pub fn failure() -> Vec<u8> {
    vec![SSH_AGENT_FAILURE]
}

/// A message with its length prefix, ready to write.
pub fn frame(msg: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(msg.len() + 4);
    put_string(&mut out, msg);
    out
}

/// One length-prefixed message, or `None` at a clean end of stream.
pub async fn read_frame<R: AsyncRead + Unpin>(reader: &mut R) -> std::io::Result<Option<Vec<u8>>> {
    let mut len = [0u8; 4];
    match reader.read_exact(&mut len).await {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let len = u32::from_be_bytes(len) as usize;
    if len == 0 || len > MAX_MESSAGE {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("agent message of {len} bytes refused"),
        ));
    }
    let mut msg = vec![0u8; len];
    reader.read_exact(&mut msg).await?;
    Ok(Some(msg))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sign_request(blob: &[u8], data: &[u8], flags: u32) -> Vec<u8> {
        let mut m = vec![SSH_AGENTC_SIGN_REQUEST];
        put_string(&mut m, blob);
        put_string(&mut m, data);
        m.extend_from_slice(&flags.to_be_bytes());
        m
    }

    #[test]
    fn requests_parse_and_bad_ones_are_refused() {
        assert_eq!(
            parse_request(&[SSH_AGENTC_REQUEST_IDENTITIES]).unwrap(),
            Request::RequestIdentities
        );
        let req = parse_request(&sign_request(b"blob", b"data", SSH_AGENT_RSA_SHA2_256)).unwrap();
        assert_eq!(
            req,
            Request::Sign {
                key_blob: b"blob".to_vec(),
                data: b"data".to_vec(),
                flags: 2
            }
        );
        assert_eq!(parse_request(&[17]).unwrap(), Request::Unsupported(17));
        assert!(parse_request(&[]).is_err());
        // A length that runs past the end is truncation, not a panic.
        let mut short = sign_request(b"blob", b"data", 0);
        short.truncate(8);
        assert!(parse_request(&short).is_err());
        let mut huge = vec![SSH_AGENTC_SIGN_REQUEST];
        huge.extend_from_slice(&u32::MAX.to_be_bytes());
        assert!(parse_request(&huge).is_err());
    }

    #[test]
    fn answers_encode_in_wire_order() {
        let answer = identities_answer(&[(b"k1".to_vec(), "one".into())]);
        assert_eq!(answer[0], SSH_AGENT_IDENTITIES_ANSWER);
        assert_eq!(&answer[1..5], &1u32.to_be_bytes());
        assert_eq!(&answer[5..9], &2u32.to_be_bytes());
        assert_eq!(&answer[9..11], b"k1");
        assert_eq!(&answer[11..15], &3u32.to_be_bytes());
        assert_eq!(&answer[15..], b"one");
        let resp = sign_response(b"sig");
        assert_eq!(
            resp,
            [&[SSH_AGENT_SIGN_RESPONSE, 0, 0, 0, 3][..], b"sig"].concat()
        );
        assert_eq!(failure(), vec![SSH_AGENT_FAILURE]);
        assert_eq!(frame(b"ab"), vec![0, 0, 0, 2, b'a', b'b']);
    }

    #[tokio::test]
    async fn frames_are_read_back_and_oversized_ones_refused() {
        let mut stream = frame(&[SSH_AGENTC_REQUEST_IDENTITIES]);
        stream.extend(frame(b"xyz"));
        let mut cursor = std::io::Cursor::new(stream);
        assert_eq!(read_frame(&mut cursor).await.unwrap(), Some(vec![11]));
        assert_eq!(
            read_frame(&mut cursor).await.unwrap(),
            Some(b"xyz".to_vec())
        );
        assert_eq!(read_frame(&mut cursor).await.unwrap(), None);
        let mut big = std::io::Cursor::new(((MAX_MESSAGE + 1) as u32).to_be_bytes().to_vec());
        assert!(read_frame(&mut big).await.is_err());
        let mut partial = std::io::Cursor::new(vec![0, 0, 0, 5, 1, 2]);
        assert!(read_frame(&mut partial).await.is_err());
    }
}
