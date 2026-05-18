import { Construct } from "constructs";
import { App, TerraformStack, TerraformOutput, LocalBackend } from "cdktf";
import { AwsProvider } from "@cdktf/provider-aws/lib/provider";
import { Instance } from "@cdktf/provider-aws/lib/instance";
import { SecurityGroup } from "@cdktf/provider-aws/lib/security-group";

class ImportDemoStack extends TerraformStack {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    new LocalBackend(this, {
      path: "terraform.tfstate",
    });

    new AwsProvider(this, "aws", {
      region: "us-east-1",
      accessKey: "test",
      secretKey: "test",
      skipCredentialsValidation: true,
      skipMetadataApiCheck: "true",
      skipRequestingAccountId: true,
      endpoints: [
        {
          ec2: "http://localhost:4566",
          sts: "http://localhost:4566",
          iam: "http://localhost:4566",
        },
      ],
      defaultTags: [
        {
          tags: {
            ManagedBy: "CDKTF",
            Origin: "team-compute",
            DemoArtifact: "three-tool-import",
          },
        },
      ],
    });

    const vpcId = process.env.DEMO_VPC_ID ?? "";
    const subnetId = process.env.DEMO_SUBNET_ID ?? "";
    const amiId = process.env.DEMO_AMI_ID ?? "";

    const sg = new SecurityGroup(this, "sg", {
      name: "imported-from-cdktf-sg",
      description: "Allow nothing; demo SG attached to imported EC2.",
      vpcId,
      tags: {
        Name: "imported-from-cdktf-sg",
      },
    });

    const instance = new Instance(this, "ec2", {
      ami: amiId,
      instanceType: "t3.micro",
      subnetId,
      vpcSecurityGroupIds: [sg.id],
      tags: {
        Name: "imported-from-cdktf",
      },
    });

    new TerraformOutput(this, "instance_id", { value: instance.id });
    new TerraformOutput(this, "security_group_id", { value: sg.id });
  }
}

const app = new App();
new ImportDemoStack(app, "import-demo");
app.synth();
