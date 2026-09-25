#!/usr/bin/env python3
"""Prints a short, readable summary of a macOS/iOS Simulator .ips crash report.

Usage: print-crash-summary.py <path-to.ips>

An .ips file is two JSON documents separated by a newline: a one-line header,
then the full report. This pulls out the exception type/signal and the
symbolicated backtrace of whichever thread actually threw -- the uncaught
Objective-C exception's backtrace if there is one (that's where a
message-send-to-a-corrupted-object crash shows up), otherwise the thread
the report marks as the faulting one.
"""
import json
import sys


def load(path):
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        header = f.readline()
        body = f.read()
    return json.loads(header), json.loads(body)


def image_name(report, image_index):
    images = report.get("usedImages", [])
    if 0 <= image_index < len(images):
        img = images[image_index]
        return img.get("name") or img.get("path") or "?"
    return "?"


def print_frames(report, frames, limit=20):
    for frame in frames[:limit]:
        symbol = frame.get("symbol", "?")
        image = image_name(report, frame.get("imageIndex", -1))
        print(f"  {image:<28} {symbol}")


def main():
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(1)

    header, report = load(sys.argv[1])

    print(f"app: {header.get('app_name')}  bug_type: {header.get('bug_type')}")

    exc = report.get("exception", {})
    term = report.get("termination", {})
    print(f"exception: {exc.get('type')} / {exc.get('signal')}")
    if term:
        print(f"termination: {term.get('namespace')} code={term.get('code')} ({term.get('indicator')})")

    last_exc_bt = report.get("lastExceptionBacktrace")
    if last_exc_bt:
        print("\nuncaught-exception backtrace (top frames, innermost first):")
        print_frames(report, last_exc_bt)
        return

    faulting = report.get("faultingThread")
    threads = report.get("threads", [])
    if faulting is not None and faulting < len(threads):
        print(f"\nfaulting thread {faulting} backtrace (top frames, innermost first):")
        print_frames(report, threads[faulting].get("frames", []))
        return

    print("\n(no lastExceptionBacktrace and no resolvable faultingThread in this report)")


if __name__ == "__main__":
    main()
