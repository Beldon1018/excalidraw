import {
  CaptureUpdateAction,
  getNonDeletedElements,
  tidyFlowchartElements,
  updateFrameMembershipOfSelectedElements,
} from "@excalidraw/element";

import { arrayToMap } from "@excalidraw/common";

import { IconButton } from "../components/IconButton";
import { TidyUpIcon } from "../components/icons";

import { t } from "../i18n";

import { isSomeElementSelected } from "../scene";

import { register } from "./register";

import type { AppClassProperties, UIAppState } from "../types";

export const tidyFlowchartPredicate = (
  _elements: Parameters<
    NonNullable<Parameters<typeof register>[0]["predicate"]>
  >[0],
  appState: UIAppState,
  _appProps: Parameters<
    NonNullable<Parameters<typeof register>[0]["predicate"]>
  >[2],
  app: AppClassProperties,
) => {
  const selectedElements = app.scene.getSelectedElements(appState);
  return (
    getNonDeletedElements(selectedElements).length > 1 &&
    selectedElements.some((element) => element.type !== "arrow")
  );
};

export const actionTidyFlowchart = register({
  name: "tidyFlowchart",
  label: "labels.tidyUp",
  icon: TidyUpIcon,
  trackEvent: { category: "element" },
  predicate: (elements, appState, appProps, app) =>
    tidyFlowchartPredicate(elements, appState, appProps, app),
  perform: (elements, appState, _, app) => {
    const selectedElements = app.scene.getSelectedElements(appState);

    tidyFlowchartElements(
      getNonDeletedElements(selectedElements) as typeof selectedElements[0][],
      app.scene,
    );

    const updatedElementsMap = arrayToMap(app.scene.getNonDeletedElements());

    return {
      appState,
      elements: updateFrameMembershipOfSelectedElements(
        elements.map(
          (element) => updatedElementsMap.get(element.id) ?? element,
        ),
        appState,
        app,
      ),
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    };
  },
  PanelComponent: ({ elements, appState, updateData, app }) => (
    <IconButton
      hidden={!tidyFlowchartPredicate(elements, appState, {} as never, app)}
      type="button"
      icon={TidyUpIcon}
      onClick={() => updateData(null)}
      title={t("labels.tidyUp")}
      aria-label={t("labels.tidyUp")}
      visible={isSomeElementSelected(getNonDeletedElements(elements), appState)}
    />
  ),
});
