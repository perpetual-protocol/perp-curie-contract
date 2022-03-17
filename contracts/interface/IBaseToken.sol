// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.7.6;

interface IBaseToken {
    event PriceFeedChanged(address indexed priceFeed);

    /// @notice Get the price feed address
    /// @return priceFeed the current price feed
    function getPriceFeed() external view returns (address priceFeed);
}
