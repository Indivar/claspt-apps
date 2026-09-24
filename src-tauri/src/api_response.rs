// Copyright (c) 2025-2026 Indivar Software Solutions Limited, Auckland, New Zealand.
// Licensed under the PolyForm Shield License 1.0.0. See LICENSE in the repository root.

//! Reading a response from the local API, for the two clients of it that live
//! in this crate: the MCP server and the command line tool.

use serde_json::Value;

/// What a local API response means to the caller. The status is read before the
/// body: the API refuses in plain text ("Invalid token", "Vault locked"), and
/// parsing that as JSON replaced the reason with "error decoding response
/// body", which told the agent and its owner nothing about what to do.
/// The response to a request made with `token`, so a refusal can name the
/// token by its hint. Which of several config files holds the stale
/// token is the one thing the owner needs to know, and the hint is what the
/// registry in Settings shows next to each client.
pub(crate) fn interpret_response_for(
    status: reqwest::StatusCode,
    body: &str,
    token: Option<&str>,
) -> Result<Value, String> {
    if !status.is_success() {
        let reason = body.trim();
        let mut message = if reason.is_empty() {
            format!("API error {status}")
        } else {
            format!("API error {status}: {reason}")
        };
        if status == reqwest::StatusCode::UNAUTHORIZED {
            message.push_str(&refusal_advice(token));
        }
        return Err(message);
    }
    serde_json::from_str(body).map_err(|e| format!("Parse failed: {e}"))
}

/// What to do about a token the open vault does not know.
pub(crate) fn refusal_advice(token: Option<&str>) -> String {
    let which = match token {
        Some(token) => format!(
            "Token {} is not one the vault open in Claspt knows",
            crate::local_api::clients::token_hint(token)
        ),
        None => {
            "The token this tool was given is not one the vault open in Claspt knows".to_string()
        }
    };
    format!(
        ". {which}. Run `claspt mcp doctor` to see which config file holds a stale token, \
         or `claspt mcp install <client>` to issue a fresh shared one"
    )
}

/// Read a response made without a token to name.
pub(crate) fn read_response(resp: reqwest::blocking::Response) -> Result<Value, String> {
    read_response_for(resp, None)
}

/// Read a response made with `token` (see [`interpret_response_for`]).
pub(crate) fn read_response_for(
    resp: reqwest::blocking::Response,
    token: Option<&str>,
) -> Result<Value, String> {
    let status = resp.status();
    let body = resp
        .text()
        .map_err(|e| format!("Reading the response failed: {e}"))?;
    interpret_response_for(status, &body, token)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The API refuses in plain text. Reading that as JSON turned "Invalid
    /// token" into "error decoding response body", which told the agent and
    /// its owner nothing about what to do.
    #[test]
    fn a_refusal_in_plain_text_is_reported_as_what_it_says() {
        let error =
            interpret_response_for(reqwest::StatusCode::UNAUTHORIZED, "Invalid token\n", None)
                .expect_err("a 401 is an error");
        assert!(error.contains("401"), "{error}");
        assert!(error.contains("Invalid token"), "{error}");
        assert!(
            error.contains("claspt mcp install"),
            "says how to get a valid token: {error}"
        );
        assert!(error.contains("claspt mcp doctor"), "{error}");
        assert!(!error.contains("Parse failed"), "{error}");
    }

    /// Four config files, three tokens: the refusal has to say which token
    /// was refused, and never more of it than the registry shows.
    #[test]
    fn a_refusal_names_the_token_by_its_hint_only() {
        let error = interpret_response_for(
            reqwest::StatusCode::UNAUTHORIZED,
            "Invalid token",
            Some("clss_0123456789abcdef9b31"),
        )
        .expect_err("a 401 is an error");
        assert!(error.contains("clss_\u{2026}9b31"), "{error}");
        assert!(
            !error.contains("0123456789"),
            "the token itself never appears: {error}"
        );
    }

    #[test]
    fn a_refusal_in_json_or_with_no_body_is_reported_too() {
        let error = interpret_response_for(
            reqwest::StatusCode::LOCKED,
            r#"{"error":"vault is locked"}"#,
            None,
        )
        .expect_err("a 423 is an error");
        assert!(error.contains("vault is locked"), "{error}");
        let error =
            interpret_response_for(reqwest::StatusCode::FORBIDDEN, "  ", None).expect_err("a 403");
        assert_eq!(error, "API error 403 Forbidden");
    }

    #[test]
    fn a_success_is_its_json_and_a_success_that_is_not_json_says_so() {
        let value =
            interpret_response_for(reqwest::StatusCode::OK, r#"{"ok":true}"#, None).unwrap();
        assert_eq!(value["ok"], true);
        let error =
            interpret_response_for(reqwest::StatusCode::OK, "<html>", None).expect_err("not JSON");
        assert!(error.starts_with("Parse failed"), "{error}");
    }
}
