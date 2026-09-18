"""Static deployment checks; never provisions services or requires credentials.

python -m pip install PyYAML==6.0.2 jsonschema==4.25.1
python deployment/validate.py [--schema-dir directory-with-downloaded-schemas]
"""
import argparse
import json
import re
from pathlib import Path
from urllib.request import urlopen

import jsonschema
import yaml


class Yaml12Loader(yaml.SafeLoader):
    """Use YAML 1.2 boolean semantics so GitHub's `on` remains a string key."""


Yaml12Loader.yaml_implicit_resolvers = {
    key: [(tag, expression) for tag, expression in values if tag != "tag:yaml.org,2002:bool"]
    for key, values in yaml.SafeLoader.yaml_implicit_resolvers.items()
}
Yaml12Loader.add_implicit_resolver(
    "tag:yaml.org,2002:bool", re.compile(r"^(?:true|false)$", re.I), list("tTfF")
)

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--schema-dir", type=Path)
args = parser.parse_args()
root = Path(__file__).resolve().parent.parent
documents = {}
for filename, schema_name, schema_url in [
    ("render.yaml", "render-schema.json", "https://render.com/schema/render.yaml.json"),
    ("compose.yml", "compose-schema.json", "https://raw.githubusercontent.com/compose-spec/compose-spec/master/schema/compose-spec.json"),
    (".github/workflows/ci.yml", "workflow-schema.json", "https://json.schemastore.org/github-workflow.json"),
]:
    document = yaml.load((root / filename).read_text(encoding="utf-8"), Loader=Yaml12Loader)
    if args.schema_dir:
        schema = json.loads((args.schema_dir / schema_name).read_text(encoding="utf-8"))
    else:
        with urlopen(schema_url, timeout=30) as response:
            schema = json.load(response)
    jsonschema.validators.validator_for(schema)(schema).validate(document)
    documents[filename] = document
    print(f"{filename}: schema passed")

render = documents["render.yaml"]
services = {item["name"]: item for item in render["services"]}
databases = {item["name"] for item in render["databases"]}
for service in services.values():
    for variable in service.get("envVars", []):
        if "fromDatabase" in variable:
            assert variable["fromDatabase"]["name"] in databases, variable
        if "fromService" in variable:
            reference = variable["fromService"]
            assert reference["name"] in services, variable
            assert services[reference["name"]]["type"] == reference["type"], variable
    assert service["region"] == "virginia"
    if service["type"] in ("web", "worker"):
        assert (root / service["dockerfilePath"]).is_file()
        assert service["numInstances"] == 1
        assert service["autoDeployTrigger"] == "off"
for database in render["databases"]:
    assert database["region"] == "virginia"
    assert database["ipAllowList"] == []
assert services["bestword-keyvalue"]["ipAllowList"] == []
print("Render references, private datastore access, region and manual instance limits: passed")

compose = documents["compose.yml"]
assert compose["services"]["postgres"]["volumes"] == ["postgres-data:/var/lib/postgresql"]
for service in compose["services"].values():
    for binding in service.get("ports", []):
        assert binding.startswith("127.0.0.1:"), binding
print("Compose host bindings and PostgreSQL 18 data volume: passed")
