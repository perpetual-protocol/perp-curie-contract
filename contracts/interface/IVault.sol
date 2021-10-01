// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;

import { IVaultStorage } from "./IVaultStorage.sol";

interface IVault is IVaultStorage {
    function balanceOf(address account) external view returns (int256);

    function getFreeCollateralByRatio(address trader, uint24 ratio) external view returns (int256);
}
