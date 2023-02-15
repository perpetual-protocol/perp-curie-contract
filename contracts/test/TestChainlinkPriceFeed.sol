// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.7.6;
pragma abicoder v2;

import { IPriceFeed } from "@perp/perp-oracle-contract/contracts/interface/IPriceFeed.sol";

contract TestChainlinkPriceFeed is IPriceFeed {
    uint256 private _price;
    bool private _sequencerIsDown;

    function decimals() external view override returns (uint8) {
        return 18;
    }

    /// @dev Returns the index price of the token.
    /// @param interval The interval represents twap interval.
    function getPrice(uint256 interval) external view override returns (uint256) {
        require(!_sequencerIsDown, "CPF_SD");
        return _price;
    }

    function setPrice(uint256 price) external {
        _price = price;
    }

    function setSequencerStatus(bool sequencerIsDown) external {
        _sequencerIsDown = sequencerIsDown;
    }
}
