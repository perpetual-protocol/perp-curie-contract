// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;

interface IBaseToken {
    // Do NOT change the order of enum values because it will break backwards compatibility
    enum Status { Open, Paused, Closed }

    event PriceFeedChanged(address indexed priceFeed);
    event StatusUpdated(Status indexed status);

    function close() external;

    function getPriceFeed() external view returns (address);

    function getPausedTimestamp() external view returns (uint256);

    function getPausedIndexPrice() external view returns (uint256);

    function isOpen() external view returns (bool);

    function isPaused() external view returns (bool);

    function isClosed() external view returns (bool);
}
