# **Open-Source Unified Platform Architecture for Advanced Infrastructure as Code Management**

## **Executive Summary and Architectural Context**

The contemporary landscape of cloud infrastructure management demands platforms that are highly automated, strictly governed, and aggressively resistant to vendor lock-in. Constructing a unified Developer Experience (DevEx) Platform requires eliminating tool sprawl and unifying the engineering organization under a single, robust Infrastructure as Code (IaC) standard.

The mandate to ensure that this entire ecosystem remains strictly open-source dictates a departure from commercial SaaS offerings and fragmented IaC wrappers. Organizations burdened by managing raw declarative HashiCorp Configuration Language (HCL) alongside programmatic abstractions (CDKTF) and orchestration wrappers (Terragrunt) face steep operational overhead, state fragmentation, and complex CI/CD requirements. By consolidating the entire organization onto a single open-source IaC methodology, teams can unlock unprecedented efficiency, streamlined governance, and frictionless developer self-service.

This comprehensive analysis delineates the optimal architectural blueprint for an enterprise-grade, open-source DevEx platform built around a singular IaC foundation. Crucially, the architecture anticipates the deep integration of artificial intelligence, utilizing Claude Code, Model Context Protocol (MCP) servers, and autonomous agentic workflows to accelerate infrastructure provisioning, remediate configuration drift, and dynamically generate complex deployment topologies.

## **Single IaC Methodology Selection: OpenTofu**

To achieve a truly unified DevEx platform devoid of commercial licensing fees, the organization must standardize on a single IaC framework. While the Cloud Development Kit for Terraform (CDKTF) and Terragrunt offer unique abstractions, maintaining a multi-tool strategy introduces unnecessary complexity.

After HashiCorp transitioned Terraform to the Business Source License (BSL), the enterprise mandate for a strictly open-source foundation requires the adoption of **OpenTofu**. Operating under the stewardship of the Linux Foundation and the MPL-2.0 license, OpenTofu serves as a direct, drop-in replacement for Terraform and guarantees absolute vendor neutrality.

### **Why Standardize Exclusively on OpenTofu?**

Consolidating purely on OpenTofu declarative HCL, rather than mixing it with CDKTF and Terragrunt, provides the strongest foundation for an automated, AI-driven DevEx platform:

1. **Deprecation and Risk of CDKTF:** HashiCorp/IBM recently announced the deprecation and archiving of the CDKTF project. While community forks like CDK Terrain (CDKTN) exist, relying on a community continuation of an abandoned, highly complex programmatic tool introduces unacceptable long-term enterprise risk. Standardizing on pure OpenTofu HCL ensures long-term viability.
2. **Elimination of Wrapper Complexity:** While Terragrunt is excellent for keeping configurations Don't Repeat Yourself (DRY), relying purely on native OpenTofu simplifies the CI/CD pipeline and integrates more cleanly with native AI agent tooling and static analysis scanners.
3. **Native State Encryption:** OpenTofu 1.7+ introduces built-in, client-side state encryption.1 This highly requested enterprise feature allows organizations to encrypt sensitive infrastructure data in remote backends using AWS KMS, GCP KMS, or OpenBao, natively securing the deployment without requiring third-party wrappers.
4. **OCI Registry Support:** OpenTofu 1.10+ supports Open Container Initiative (OCI) registries, allowing teams to distribute custom modules through standard container registries (like Docker Hub or GitHub Container Registry), dramatically simplifying module sharing in secure or air-gapped enterprise environments.

## **The Infrastructure Migration and Importation Imperative**

Transitioning to a unified OpenTofu baseline requires migrating all existing CDKTF logic, Terragrunt wrappers, and manually created ("ClickOps") infrastructure into standard OpenTofu HCL and state files.

### **Migrating Legacy IaC to OpenTofu**

For CDKTF migrations, the platform engineering team must synthesize the existing CDKTF code into its underlying JSON representation, translate it into standard HCL, and seamlessly move the resources into a standard OpenTofu state file without triggering destructive operations. For Terragrunt, the migration involves flattening the hierarchical terragrunt.hcl structures into native OpenTofu modules and migrating the backend states.

### **Enterprise-Scale Importation Tooling**

To codify unmanaged cloud assets, the platform leverages the declarative import block, fully supported by OpenTofu.

By executing tofu plan \-generate-config-out=generated.tf, the execution engine queries the cloud provider's API and automatically authors the complete, semantic HCL code required to manage the existing resources.

For massive brownfield migrations, open-source utilities like **Terraformer** or **Terracognita** can connect directly to the public cloud provider and generate both the state files and the corresponding structural HCL configuration files for entire architectural ecosystems.2

## **Execution Orchestration and State Management**

To execute OpenTofu automatically upon Git pull requests without relying on commercial SaaS platforms, the platform must employ a specialized, open-source IaC continuous integration tool.

To meet the rigorous requirement of maintaining the highest standard of security, **Digger** is the optimal architectural choice for execution orchestration. Digger represents a modern, lightweight open-source alternative designed explicitly around a "Bring Your Own Compute" (BYOC) philosophy.4

Rather than running a monolithic server that stores highly privileged cloud credentials, Digger acts purely as an intelligent orchestrator.4 It coordinates the execution of infrastructure runs by spinning up ephemeral jobs natively within the organization's existing CI/CD pipelines, such as GitHub Actions or GitLab CI. Security is hardened by utilizing OpenID Connect (OIDC) protocols, allowing the ephemeral CI runners to assume temporary, short-lived cloud IAM roles without ever storing static secret keys. Digger also provides enterprise-grade features in its open-source offering, including PR-level locks to prevent race conditions and Role-Based Access Control (RBAC) via Open Policy Agent (OPA).

## **Uncompromising Security and Governance**

Security must be programmatically enforced at the compilation, integration, and deployment stages through automated guardrails, ensuring compliance with frameworks like SLSA (Supply-chain Levels for Software Artifacts).

1. **Policy-as-Code (PaC):** The platform will utilize **Open Policy Agent (OPA)**, a platform-agnostic engine utilizing the Rego declarative query language. Within the Digger CI/CD pipeline, OPA dynamically evaluates the outputted OpenTofu JSON execution plans. If a developer attempts to provision a non-compliant resource, OPA issues a failure exit code, instructing Digger to halt the pipeline.
2. **Static Code Analysis:** **Checkov** and **Trivy** will be embedded into the pipeline to scan the raw OpenTofu HCL prior to the planning phase. These tools identify hardcoded secrets, overly permissive IAM wildcard roles, and insecure network configurations.
3. **Decentralized Secret Management:** Hardcoding secrets is strictly prohibited. The platform will employ **Infisical**, a comprehensive open-source secret management platform.5 Infisical can be seamlessly self-hosted and integrates directly with CI/CD runners, injecting necessary environmental variables and temporary credentials securely at runtime.5

## **The Internal Developer Portal (IDP) Architecture**

To abstract the underlying OpenTofu complexity and provide a frictionless DevEx, the platform will utilize **Backstage**, the powerful open-source framework managed as a Cloud Native Computing Foundation (CNCF) incubating project.

Backstage acts as the single pane of glass through which developers provision resources. The core operational functionality is driven by Backstage Software Templates, establishing "Golden Paths."

1. A developer navigates to Backstage and selects a pre-approved template for a new resource (e.g., an S3 bucket or a managed PostgreSQL database).
2. The Backstage Scaffolder automatically generates the necessary OpenTofu HCL code adhering to organizational standards.
3. Backstage commits this code to the designated Git repository, opening a Pull Request.
4. This immediately triggers the Digger CI/CD orchestration engine, which runs OPA checks, generates an execution plan, and posts the results back to the PR for final review and merging.

## **Advanced AI Integration: Claude Code and Agentic Workflows**

The most transformative capability of this DevEx platform is the deep integration of AI agents utilizing **Claude Code** and the **Model Context Protocol (MCP)**. By standardizing purely on OpenTofu, the platform unlocks highly deterministic, autonomous AI interactions that would be unmanageable in a fragmented, multi-tool environment.

### **The Model Context Protocol (MCP)**

MCP is an open standard that allows AI agents to securely connect to external tools, APIs, and data sources. Instead of relying on Claude's static training data—which often contains deprecated Terraform syntax or outdated provider modules—the platform will deploy specialized MCP servers.

1. **OpenTofu Registry MCP Server:** This server exposes the OpenTofu Registry documentation directly to Claude Code. When a developer prompts Claude Code to generate an infrastructure block, the AI agent dynamically queries the live registry via MCP, ensuring the generated HCL uses the most accurate, up-to-date provider schemas and best practices.
2. **Infrastructure Execution MCP Servers:** Using tools like the Cortex OpenTofu MCP server, Claude Code can safely execute infrastructure operations. This enables AI assistants to manage infrastructure directly, protected by built-in safety features, human-in-the-loop approval gates, and comprehensive audit logging.

### **Autonomous Agent Skills for Infrastructure**

Generic AI often generates monolithic, insecure, or untestable infrastructure code. To elevate Claude Code from a general assistant to a senior infrastructure architect, the platform repository will implement specific **Agent Skills** (such as terraform-style-guide and terraform-refactor-module).

These skills act as packaged expertise loaded automatically by Claude.

* **Drift Remediation:** If configuration drift is detected, a Claude agent can analyze the live cloud state, cross-reference the OpenTofu codebase, and autonomously author a Pull Request with the exact HCL required to reconcile the drift.
* **Intelligent Refactoring:** Claude Code, equipped with the terraform-refactor-module skill, can safely break down massive monolithic HCL files into clean, reusable OpenTofu modules, automatically generating the necessary moved blocks to ensure state remains uncorrupted during the transition.
* **Automated Testing:** Agents can autonomously generate native .tftest.hcl test files for new OpenTofu modules, ensuring all new infrastructure meets rigorous testing standards before deployment.

## **Master Implementation Plan**

1. **Phase 1: Foundational Selection & Orchestration:** Standardize all new infrastructure on OpenTofu HCL. Deploy Digger integrated with GitHub/GitLab CI runners for secure, BYOC execution orchestration.
2. **Phase 2: Legacy Code Migration:** Aggressively deprecate CDKTF and Terragrunt usage. Utilize native OpenTofu import blocks and reverse-engineering utilities to translate programmatic wrappers and legacy ClickOps resources into pure, modular HCL.
3. **Phase 3: Security & Self-Service IDP:** Embed OPA, Checkov, and Infisical into the Digger pipeline to ensure zero-trust compliance. Deploy Backstage and configure Software Templates to allow developers to trigger OpenTofu provisioning via GUI.
4. **Phase 4: Agentic AI Rollout:** Deploy Claude Code across the engineering organization. Configure the OpenTofu Registry MCP server and inject custom Agent Skills (CLAUDE.md) to enable autonomous infrastructure generation, intelligent refactoring, and automated drift remediation.

#### **Works cited**

1. OpenTofu, accessed May 15, 2026, [https://opentofu.org/](https://opentofu.org/)
2. GoogleCloudPlatform/terraformer: CLI tool to generate terraform files from existing infrastructure (reverse Terraform). Infrastructure to Code \- GitHub, accessed May 15, 2026, [https://github.com/googlecloudplatform/terraformer](https://github.com/googlecloudplatform/terraformer)
3. Importing Existing Infrastructure into Terraform using Terraformer | by Sachithra\_Manamperi, accessed May 15, 2026, [https://sachithramanamperi.medium.com/importing-existing-infrastructure-into-terraform-using-terraformer-f43fe7be38e3](https://sachithramanamperi.medium.com/importing-existing-infrastructure-into-terraform-using-terraformer-f43fe7be38e3)
4. Digger and Atlantis: key differences | by Digger HQ | Medium, accessed May 15, 2026, [https://medium.com/@DiggerHQ/digger-and-atlantis-key-differences-c08029ffe112](https://medium.com/@DiggerHQ/digger-and-atlantis-key-differences-c08029ffe112)
5. Top HashiCorp Vault Alternatives \[2026\] \- Infisical, accessed May 15, 2026, [https://infisical.com/blog/hashicorp-vault-alternatives](https://infisical.com/blog/hashicorp-vault-alternatives)
