// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;

import { IInsuranceFund } from "../interface/IInsuranceFund.sol";

abstract contract InsuranceFundStorageV1 is IInsuranceFund {
    // --------- IMMUTABLE ---------

    address public override token;

    // --------- ^^^^^^^^^ ---------

    address internal borrower;
}
