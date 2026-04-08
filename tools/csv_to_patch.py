#!/usr/bin/env python3
"""
csv_to_patch.py
---------------
Converts parcel_audit_results.csv → parcel_address_patch.json.

Reads rows where status == 'MISMATCH' and dcad_situs_address is non-empty,
then writes the patch JSON that apply_parcel_patch.py consumes.

Usage:
    python3 csv_to_patch.py [tools/parcel_audit_results.csv]
"""

import csv, json, os, sys

HERE   = os.path.dirname(__file__)
IN_CSV  = os.path.join(HERE, 'parcel_audit_results.csv')
OUT_JSON = os.path.join(HERE, 'parcel_address_patch.json')

def main():
    src = sys.argv[1] if len(sys.argv) > 1 else IN_CSV
    if not os.path.exists(src):
        print(f'ERROR: {src} not found', file=sys.stderr)
        sys.exit(1)

    patches = []
    with open(src, newline='', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for row in reader:
            status   = row.get('status', '').strip().upper()
            corrected = (row.get('dcad_situs_address') or '').strip()
            if status == 'MISMATCH' and corrected:
                patches.append({
                    'feature_index':     int(row['feature_index']),
                    'parcel_id':         row.get('parcel_id', ''),
                    'old_address':       row.get('current_address', ''),
                    'corrected_address': corrected,
                })

    with open(OUT_JSON, 'w', encoding='utf-8') as f:
        json.dump(patches, f, indent=2)

    print(f'{len(patches)} patches written to {OUT_JSON}')

if __name__ == '__main__':
    main()
