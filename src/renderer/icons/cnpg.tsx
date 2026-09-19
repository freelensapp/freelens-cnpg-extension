/**
 * Copyright (c) Freelens Authors. All rights reserved.
 * Licensed under MIT License. See LICENSE in root directory for more information.
 */

// Original monochrome glyph for the sidebar root: a database cylinder with
// three dots for the instances of a cluster. No fill or stroke attributes, the
// host applies `fill: currentColor` (DESIGN.md section 4).

import { Renderer } from "@freelensapp/extensions";
import svgIcon from "./cnpg.svg?raw";

const {
  Component: { Icon },
} = Renderer;

export function CnpgIcon(props: Renderer.Component.IconProps) {
  return <Icon {...props} svg={svgIcon} />;
}
