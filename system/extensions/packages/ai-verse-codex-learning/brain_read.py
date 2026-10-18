"""Read-only transport to the installed Brain's public Purpose snapshot."""
import argparse
import json
from aiverse_brain.controller import BrainController
from aiverse_brain.purpose_snapshot import build_purpose_snapshot

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', required=True)
    parser.add_argument('--scope', required=True)
    args = parser.parse_args()
    print(json.dumps(build_purpose_snapshot(BrainController(args.root), args.scope)))
