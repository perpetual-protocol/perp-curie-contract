// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;
pragma experimental ABIEncoderV2;

import { IStdReference } from "@perp/perp-oracle-contract/contracts/interface/bandProtocol/IStdReference.sol";

contract TestStdReference is IStdReference {
    ReferenceData public refData;

    constructor() {}

    function getReferenceData(string memory _base, string memory _quote)
        external
        view
        override
        returns (ReferenceData memory)
    {
        return refData;
    }

    function getReferenceDataBulk(string[] memory _bases, string[] memory _quotes)
        external
        view
        override
        returns (ReferenceData[] memory)
    {
        revert();
    }
}
