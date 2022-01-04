// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;

interface IBaseToken {
    event PriceFeedChanged(address indexed priceFeed);

    function getPriceFeed() external view returns (address);
}
