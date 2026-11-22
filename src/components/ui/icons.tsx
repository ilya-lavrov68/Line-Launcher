import type { ComponentProps, ComponentType } from "react";
import { cn } from "@/lib/utils";

import alertCircle from "@material-symbols/svg-400/rounded/error.svg";
import alertTriangle from "@material-symbols/svg-400/rounded/warning.svg";
import arrowBack from "@material-symbols/svg-400/rounded/arrow_back.svg";
import northEast from "@material-symbols/svg-400/rounded/north_east.svg";
import check from "@material-symbols/svg-400/rounded/check.svg";
import checkCircle from "@material-symbols/svg-400/rounded/check_circle.svg";
import expandMore from "@material-symbols/svg-400/rounded/keyboard_arrow_down.svg";
import chevronLeft from "@material-symbols/svg-400/rounded/chevron_left.svg";
import chevronRight from "@material-symbols/svg-400/rounded/chevron_right.svg";
import expandLess from "@material-symbols/svg-400/rounded/keyboard_arrow_up.svg";
import contentCopy from "@material-symbols/svg-400/rounded/content_copy.svg";
import cropSquare from "@material-symbols/svg-400/rounded/crop_square.svg";
import cloudDownload from "@material-symbols/svg-400/rounded/cloud_download.svg";
import cloudOff from "@material-symbols/svg-400/rounded/cloud_off.svg";
import coffee from "@material-symbols/svg-400/rounded/coffee.svg";
import download from "@material-symbols/svg-400/rounded/download.svg";
import visibility from "@material-symbols/svg-400/rounded/visibility.svg";
import visibilityOff from "@material-symbols/svg-400/rounded/visibility_off.svg";
import description from "@material-symbols/svg-400/rounded/description.svg";
import driveFileMove from "@material-symbols/svg-400/rounded/drive_file_move.svg";
import folderOpen from "@material-symbols/svg-400/rounded/folder_open.svg";
import sportsEsports from "@material-symbols/svg-400/rounded/sports_esports.svg";
import speed from "@material-symbols/svg-400/rounded/speed.svg";
import hardDrive from "@material-symbols/svg-400/rounded/hard_drive.svg";
import history from "@material-symbols/svg-400/rounded/history.svg";
import info from "@material-symbols/svg-400/rounded/info.svg";
import gridView from "@material-symbols/svg-400/rounded/grid_view.svg";
import layers from "@material-symbols/svg-400/rounded/layers.svg";
import language from "@material-symbols/svg-400/rounded/language.svg";
import link from "@material-symbols/svg-400/rounded/link.svg";
import progressActivity from "@material-symbols/svg-400/rounded/progress_activity.svg";
import login from "@material-symbols/svg-400/rounded/login.svg";
import logout from "@material-symbols/svg-400/rounded/logout.svg";
import mail from "@material-symbols/svg-400/rounded/mail.svg";
import memory from "@material-symbols/svg-400/rounded/memory.svg";
import chatBubble from "@material-symbols/svg-400/rounded/chat_bubble.svg";
import remove from "@material-symbols/svg-400/rounded/remove.svg";
import displaySettings from "@material-symbols/svg-400/rounded/display_settings.svg";
import moreHoriz from "@material-symbols/svg-400/rounded/more_horiz.svg";
import inventory from "@material-symbols/svg-400/rounded/inventory_2.svg";
import palette from "@material-symbols/svg-400/rounded/palette.svg";
import playArrow from "@material-symbols/svg-400/rounded/play_arrow.svg";
import add from "@material-symbols/svg-400/rounded/add.svg";
import refresh from "@material-symbols/svg-400/rounded/refresh.svg";
import replay from "@material-symbols/svg-400/rounded/replay.svg";
import dns from "@material-symbols/svg-400/rounded/dns.svg";
import settings from "@material-symbols/svg-400/rounded/settings.svg";
import gppMaybe from "@material-symbols/svg-400/rounded/gpp_maybe.svg";
import verifiedUser from "@material-symbols/svg-400/rounded/verified_user.svg";
import shield from "@material-symbols/svg-400/rounded/shield.svg";
import checkroom from "@material-symbols/svg-400/rounded/checkroom.svg";
import stop from "@material-symbols/svg-400/rounded/stop.svg";
import viewList from "@material-symbols/svg-400/rounded/view_list.svg";
import deleteIcon from "@material-symbols/svg-400/rounded/delete.svg";
import personAdd from "@material-symbols/svg-400/rounded/person_add.svg";
import person from "@material-symbols/svg-400/rounded/person.svg";
import wifi from "@material-symbols/svg-400/rounded/wifi.svg";
import wifiOff from "@material-symbols/svg-400/rounded/wifi_off.svg";
import close from "@material-symbols/svg-400/rounded/close.svg";

/** Props shared by the app's icon components. */
export type LineIconProps = Omit<ComponentProps<"span">, "children">;
export type LineIcon = ComponentType<LineIconProps>;

function materialSymbol(src: string): LineIcon {
  function MaterialSymbol({ className, style, ...props }: LineIconProps) {
    const {
      "aria-hidden": ariaHidden,
      "aria-label": ariaLabel,
      ...spanProps
    } = props;
    const mask = `url("${src}")`;
    return (
      <span
        {...spanProps}
        className={cn("line-symbol", className)}
        aria-hidden={ariaHidden ?? (ariaLabel ? undefined : true)}
        aria-label={ariaLabel}
        style={{
          ...style,
          maskImage: mask,
          maskMode: "alpha",
          maskRepeat: "no-repeat",
          maskPosition: "center",
          maskSize: "contain",
          WebkitMaskImage: mask,
          WebkitMaskRepeat: "no-repeat",
          WebkitMaskPosition: "center",
          WebkitMaskSize: "contain",
        }}
      />
    );
  }
  MaterialSymbol.displayName = "MaterialSymbol";
  return MaterialSymbol;
}

// Retain semantic component names throughout the app while drawing soft,
// rounded Material Symbols SVGs. CSS masks preserve currentColor and sizing.
export const AlertCircle = materialSymbol(alertCircle);
export const AlertTriangle = materialSymbol(alertTriangle);
export const ArrowLeft = materialSymbol(arrowBack);
export const ArrowUpRight = materialSymbol(northEast);
export const Check = materialSymbol(check);
export const CheckCircle2 = materialSymbol(checkCircle);
export const CheckIcon = Check;
export const ChevronDown = materialSymbol(expandMore);
export const ChevronDownIcon = ChevronDown;
export const ChevronLeft = materialSymbol(chevronLeft);
export const ChevronRight = materialSymbol(chevronRight);
export const ChevronUp = materialSymbol(expandLess);
export const ChevronUpIcon = ChevronUp;
export const ClipboardCopy = materialSymbol(contentCopy);
export const CloudDownload = materialSymbol(cloudDownload);
export const CloudOff = materialSymbol(cloudOff);
export const Coffee = materialSymbol(coffee);
export const Copy = materialSymbol(contentCopy);
export const CropSquare = materialSymbol(cropSquare);
export const Download = materialSymbol(download);
export const Eye = materialSymbol(visibility);
export const EyeOff = materialSymbol(visibilityOff);
export const FileText = materialSymbol(description);
export const FolderInput = materialSymbol(driveFileMove);
export const FolderOpen = materialSymbol(folderOpen);
export const Gamepad2 = materialSymbol(sportsEsports);
export const Gauge = materialSymbol(speed);
export const HardDrive = materialSymbol(hardDrive);
export const History = materialSymbol(history);
export const Info = materialSymbol(info);
export const LayoutGrid = materialSymbol(gridView);
export const Layers = materialSymbol(layers);
export const Layers2 = Layers;
export const Languages = materialSymbol(language);
export const Link2 = materialSymbol(link);
export const Loader2 = materialSymbol(progressActivity);
export const LogIn = materialSymbol(login);
export const LogOut = materialSymbol(logout);
export const Mail = materialSymbol(mail);
export const MemoryStick = materialSymbol(memory);
export const MessageSquare = materialSymbol(chatBubble);
export const Minus = materialSymbol(remove);
export const MonitorCog = materialSymbol(displaySettings);
export const MoreHorizontal = materialSymbol(moreHoriz);
export const PackageX = materialSymbol(inventory);
export const Palette = materialSymbol(palette);
export const Play = materialSymbol(playArrow);
export const Plus = materialSymbol(add);
export const RefreshCw = materialSymbol(refresh);
export const RotateCcw = materialSymbol(replay);
export const Server = materialSymbol(dns);
export const ServerIcon = Server;
export const Settings = materialSymbol(settings);
export const ShieldAlert = materialSymbol(gppMaybe);
export const ShieldCheck = materialSymbol(verifiedUser);
export const ShieldX = materialSymbol(shield);
export const Shirt = materialSymbol(checkroom);
export const Square = materialSymbol(stop);
export const ListCollapse = materialSymbol(viewList);
export const Trash2 = materialSymbol(deleteIcon);
export const UserPlus = materialSymbol(personAdd);
export const UserRound = materialSymbol(person);
export const Wifi = materialSymbol(wifi);
export const WifiOff = materialSymbol(wifiOff);
export const X = materialSymbol(close);
export const XIcon = X;
