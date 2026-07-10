#!/usr/bin/env python3
"""Stateless BaoStock protocol-frame relay.

stdin is one JSON job. stdout is JSONL containing only captured application
frames and a completion record. BaoStock diagnostics are redirected to stderr.
"""

import base64
import contextlib
import json
import os
import socket
import sys
from typing import Any, Callable, Dict

import baostock as bs
import baostock.common.contants as constants
import baostock.util.socketutil as socketutil


PROTOCOL_STDOUT = sys.stdout
constants.BAOSTOCK_SERVER_IP = os.environ.get(
    "ATM3_BAOSTOCK_HOST",
    "public-api.baostock.com",
)
socket.setdefaulttimeout(30)


def emit(value: Dict[str, Any]) -> None:
    PROTOCOL_STDOUT.write(json.dumps(value, ensure_ascii=True) + "\n")
    PROTOCOL_STDOUT.flush()


def require_string(params: Dict[str, Any], name: str) -> str:
    value = params.get(name)
    if not isinstance(value, str) or not value:
        raise ValueError("params.%s must be a non-empty string" % name)
    return value


def optional_string(params: Dict[str, Any], name: str) -> Any:
    value = params.get(name)
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError("params.%s must be a string" % name)
    return value


def dispatch(api: str, params: Dict[str, Any]) -> Any:
    calls: Dict[str, Callable[[], Any]] = {
        "query_trade_dates": lambda: bs.query_trade_dates(
            start_date=optional_string(params, "start_date"),
            end_date=optional_string(params, "end_date"),
        ),
        "query_all_stock": lambda: bs.query_all_stock(
            day=optional_string(params, "day"),
        ),
        "query_stock_basic": lambda: bs.query_stock_basic(
            code=optional_string(params, "code") or "",
            code_name=optional_string(params, "code_name") or "",
        ),
        "query_history_k_data_plus": lambda: bs.query_history_k_data_plus(
            require_string(params, "code"),
            require_string(params, "fields"),
            start_date=optional_string(params, "start_date"),
            end_date=optional_string(params, "end_date"),
            frequency=optional_string(params, "frequency") or "d",
            adjustflag=optional_string(params, "adjustflag") or "3",
        ),
        "query_dividend_data": lambda: bs.query_dividend_data(
            require_string(params, "code"),
            year=optional_string(params, "year"),
            yearType=optional_string(params, "yearType") or "report",
        ),
        "query_adjust_factor": lambda: bs.query_adjust_factor(
            require_string(params, "code"),
            start_date=optional_string(params, "start_date"),
            end_date=optional_string(params, "end_date"),
        ),
    }
    call = calls.get(api)
    if call is None:
        raise ValueError("unsupported api: %s" % api)
    return call()


def read_job() -> Dict[str, Any]:
    text = sys.stdin.read()
    value = json.loads(text)
    if not isinstance(value, dict):
        raise ValueError("job must be a JSON object")
    if not isinstance(value.get("api"), str):
        raise ValueError("job.api must be a string")
    if not isinstance(value.get("params", {}), dict):
        raise ValueError("job.params must be an object")
    return value


def main() -> int:
    job = read_job()
    frame_count = 0
    original_send = socketutil.send_msg

    with contextlib.redirect_stdout(sys.stderr):
        login = bs.login()
    if login.error_code != "0":
        raise RuntimeError("BaoStock login failed: %s %s" % (
            login.error_code,
            login.error_msg,
        ))

    def capture_send(request: str) -> str:
        nonlocal frame_count
        frame = original_send(request)
        if frame is None:
            raise RuntimeError("BaoStock returned no protocol frame")
        frame_count += 1
        emit({
            "seq": frame_count,
            "request": request,
            "frame_b64": base64.b64encode(frame.encode("utf-8")).decode("ascii"),
        })
        return frame

    socketutil.send_msg = capture_send
    try:
        with contextlib.redirect_stdout(sys.stderr):
            result = dispatch(job["api"], job.get("params", {}))
            if result is None:
                raise RuntimeError("BaoStock call returned no result")
            if result.error_code != "0":
                raise RuntimeError("BaoStock query failed: %s %s" % (
                    result.error_code,
                    result.error_msg,
                ))
            while result.next():
                result.get_row_data()
    finally:
        socketutil.send_msg = original_send
        with contextlib.redirect_stdout(sys.stderr):
            bs.logout()

    emit({
        "done": True,
        "frames": frame_count,
        "client_version": bs.__version__,
        "login_code": login.error_code,
    })
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        print("baostock relay: %s" % error, file=sys.stderr)
        sys.exit(1)
