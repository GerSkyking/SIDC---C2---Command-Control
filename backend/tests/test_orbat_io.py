"""ORBAT-Export/-Import als JSON-Datei."""


def _mk(admin):
    o = admin.post("/api/orbats", json={"name": "Export-Test", "affiliation": "hostile", "notes": "n"}).json()
    root = admin.post(f"/api/orbats/{o['id']}/nodes", json={"name": "Kp", "sidc": "10031000000000000000", "qty_planned": 3}).json()
    admin.post(f"/api/orbats/{o['id']}/nodes", json={"name": "1. Zug", "parent_id": root["id"], "qty_planned": 2, "rel_visible": True})
    return o["id"]


def test_export_enthaelt_baum_ohne_db_ids_der_rechte(admin):
    oid = _mk(admin)
    d = admin.get(f"/api/orbats/{oid}/export").json()
    assert d["format"] == "sidc-orbat" and d["name"] == "Export-Test" and d["affiliation"] == "hostile"
    assert len(d["nodes"]) == 2
    child = next(n for n in d["nodes"] if n["name"] == "1. Zug")
    root = next(n for n in d["nodes"] if n["name"] == "Kp")
    assert child["parent"] == root["ref"] and root["parent"] is None
    assert "acl" not in d


def test_import_legt_neues_orbat_mit_neuen_ids_an(admin):
    oid = _mk(admin)
    d = admin.get(f"/api/orbats/{oid}/export").json()
    r = admin.post("/api/orbats/import", json=d)
    assert r.status_code == 201
    new = r.json()
    assert new["id"] != oid and new["name"] == "Export-Test" and new["affiliation"] == "hostile"
    assert len(new["nodes"]) == 2
    by_name = {n["name"]: n for n in new["nodes"]}
    assert by_name["1. Zug"]["parent_id"] == by_name["Kp"]["id"]
    assert by_name["Kp"]["id"] not in {n["ref"] for n in d["nodes"]}
    assert by_name["1. Zug"]["rel_visible"] is True
    assert by_name["Kp"]["sidc"][3] == "6"  # Identität passt zur Zugehörigkeit (hostile)


def test_import_lehnt_fremde_dateien_und_zyklen_ab(admin):
    assert admin.post("/api/orbats/import", json={"format": "etwas-anderes", "nodes": []}).status_code == 400
    zyklus = {"format": "sidc-orbat", "version": 1, "name": "Z", "nodes": [
        {"ref": "a", "parent": "b", "name": "A"}, {"ref": "b", "parent": "a", "name": "B"}]}
    assert admin.post("/api/orbats/import", json=zyklus).status_code == 400
    doppelt = {"format": "sidc-orbat", "version": 1, "nodes": [{"ref": "a"}, {"ref": "a"}]}
    assert admin.post("/api/orbats/import", json=doppelt).status_code == 400
    neu = {"format": "sidc-orbat", "version": 99, "nodes": []}
    assert admin.post("/api/orbats/import", json=neu).status_code == 400
