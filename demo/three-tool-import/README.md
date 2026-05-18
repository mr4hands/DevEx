# Three-tool import demo

Demonstrates the `opentofu-aws-import` flow when the resources being adopted
were originally created by **three different IaC tools** and the target
codebase wires them across **two modules**.

```
              Moto (localhost:4566)
                       ▲
   ┌───────────────────┼───────────────────┐
   │                   │                   │
 [TF]              [Terragrunt]          [CDKTF]
 VPC               Subnet                SG + EC2
   │                   │                   │
   └─────────── import { } blocks ─────────┘
                       │
                       ▼
        target/  (single OpenTofu state)
          module "vpc"  ──outputs──▶  module "ec2"
            ▲                          ▲
        (VPC+subnet)               (SG+instance)
```

## Files

```
demo/three-tool-import/
├── source/                       # the "previously created elsewhere" side
│   ├── tf/                       # plain OpenTofu/Terraform → creates a VPC
│   ├── tg/                       # Terragrunt + nested TF module → creates a subnet
│   ├── cdktf/                    # CDKTF (TypeScript) stack → creates an SG + EC2
│   └── apply-sources.sh          # runs all three in order, exports IDs
└── target/                       # the "after adoption" side
    ├── modules/vpc/              # minimal VPC + subnet module
    ├── modules/ec2/              # minimal SG + instance module (uses vpc outputs)
    ├── main.tf                   # provider + module instantiations + import blocks
    ├── variables.tf              # cloud IDs passed in as TF_VAR_* env vars
    └── outputs.tf
```

## Running the demo

Pre-reqs: Moto up (`make local-up`), `tofu`, `terragrunt`, `node`, `npm` in PATH.

```bash
# 0. From repo root, ensure Moto is healthy
docker ps | grep devex-moto

# 1. Apply the three source tools (creates resources in Moto)
source dev.local.env
./demo/three-tool-import/source/apply-sources.sh
# Writes IDs to demo/three-tool-import/source/ids.env

# 2. Plan the adoption (target side picks IDs up via TF_VAR_* env vars)
source demo/three-tool-import/source/ids.env
cd demo/three-tool-import/target
tofu init
tofu plan
```

## Expected plan shape

```
Plan: 4 to import, 0 to add, 0 to change, 0 to destroy.
```

Modulo **default_tags reconciliation**: resources created by the source
tools carry only those tools' default_tags (`ManagedBy = Terraform` etc.).
The target root sets `ManagedBy = OpenTofu` + `Project = DevEx-Platform` +
`Environment = demo-import`. So the actual plan shows:

```
Plan: 4 to import, 0 to add, 4 to change, 0 to destroy.
```

The `~ update` lines re-tag each imported resource to carry the target's
default_tags. This is **intentional reconciliation**, not residual drift —
same pattern documented in the `opentofu-aws-import` skill.

## Module dependency

```hcl
module "vpc" {                       # imports VPC (TF) + subnet (Terragrunt)
  source = "./modules/vpc"
  ...
}

module "ec2" {                       # imports SG + instance (CDKTF)
  source    = "./modules/ec2"
  vpc_id    = module.vpc.vpc_id      # ← consumes vpc outputs
  subnet_id = module.vpc.subnet_id   # ← consumes vpc outputs
  ...
}
```

Each `import { }` block targets `module.<name>.<resource_type>.<label>` —
the address is module-qualified.

## Tearing it down

```bash
cd demo/three-tool-import/source/cdktf && npx cdktf destroy --auto-approve
cd ../tg                              && terragrunt apply -destroy -auto-approve
cd ../tf                              && tofu destroy -auto-approve
# Or just: make local-clean && make local-up   (wipes Moto)
```

## Why this shape

- The source tools each demonstrate one major IaC paradigm:
  - **TF**: pure HCL, single tool.
  - **Terragrunt**: HCL + Terragrunt wrapper for DRY/composition.
  - **CDKTF**: programmatic (TypeScript) construction of TF state.
- From AWS's perspective the resources are indistinguishable — once they
  exist in cloud, the import flow is identical regardless of origin tool.
- The two-module split shows that `import { }`'s `to` address can target
  **inside a module** (`module.vpc.aws_vpc.this`) and that wiring between
  modules works exactly as it would for greenfield resources.
