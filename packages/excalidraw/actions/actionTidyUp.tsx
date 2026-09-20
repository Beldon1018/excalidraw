import { getNonDeletedElements } from "@excalidraw/element";

import { arrayToMap } from "@excalidraw/common";

import { tidyUpElements } from "@excalidraw/element";

import { CaptureUpdateAction } from "@excalidraw/element";

import { IconButton } from "../components/IconButton";
import { TidyUpIcon } from "../components/icons";

import { t } from "../i18n";

import { isSomeElementSelected } from "../scene";

import { register } from "./register";

import type { AppClassProperties, UIAppState } from "../types";

const enableTidyUp = (appState: UIAppState, app: AppClassProperties) =>
  app.scene.getSelectedElements({
    selectedElementIds: appState.selectedElementIds,
  }).length > 1;

export const actionTidyUp = register({
  name: "tidyUp",
  label: "labels.tidyUp",
  icon: TidyUpIcon,
  trackEvent: { category: "element" },
  predicate: (elements, appState, appProps, app) =>
    enableTidyUp(appState as UIAppState, app),
  perform: (elements, appState, _, app) => {
    const selectedElements = app.scene.getSelectedElements({
      selectedElementIds: appState.selectedElementIds,
      includeBoundTextElement: true,
      includeElementsInFrames: true,
    });

    const updatedElements = tidyUpElements(selectedElements, app.scene);

    if (!updatedElements.length) {
      return false;
    }

    const updatedElementsMap = arrayToMap(updatedElements);

    return {
      appState,
      elements: elements.map(
        (element) => updatedElementsMap.get(element.id) || element,
      ),
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    };
  },
  PanelComponent: ({ elements, appState, updateData, app }) => (
    <IconButton
      hidden={!enableTidyUp(appState, app)}
      type="button"
      icon={TidyUpIcon}
      onClick={() => updateData(null)}
      title={t("labels.tidyUp")}
      aria-label={t("labels.tidyUp")}
      visible={isSomeElementSelected(getNonDeletedElements(elements), appState)}
    />
  ),
});
