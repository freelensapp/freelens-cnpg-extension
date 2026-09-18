import { Renderer } from "@freelensapp/extensions";

/** CRD descriptor of the CloudNativePG kinds: the host shape plus the page title. */
export interface CnpgKubeObjectCRD extends Renderer.K8sApi.LensExtensionKubeObjectCRD {
  title: string;
}

/** Kubernetes condition as written by the CloudNativePG operator (SPEC-0001 R2). */
export interface KubeCondition {
  type: string;
  status: "True" | "False" | "Unknown";
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
  observedGeneration?: number;
}
