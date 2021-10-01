// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;

import { IInsuranceFundStorage } from "./IInsuranceFundStorage.sol";

interface IInsuranceFund is IInsuranceFundStorage {
    function borrow(uint256 amount) external;
}
