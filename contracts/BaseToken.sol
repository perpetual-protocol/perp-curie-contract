// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.7.6;

import { SafeMathUpgradeable } from "@openzeppelin/contracts-upgradeable/math/SafeMathUpgradeable.sol";
import { IPriceFeed } from "@perp/perp-oracle-contract/contracts/interface/IPriceFeed.sol";
import { IIndexPrice } from "./interface/IIndexPrice.sol";
import { VirtualToken } from "./VirtualToken.sol";
import { BaseTokenStorageV2 } from "./storage/BaseTokenStorage.sol";
import { IBaseToken } from "./interface/IBaseToken.sol";
import { BlockContext } from "./base/BlockContext.sol";

// never inherit any new stateful contract. never change the orders of parent stateful contracts
contract BaseToken is IBaseToken, IIndexPrice, VirtualToken, BlockContext, BaseTokenStorageV2 {
    using SafeMathUpgradeable for uint256;
    using SafeMathUpgradeable for uint8;

    //
    // CONSTANT
    //

    uint256 constant TWAP_INTERVAL_FOR_PAUSE = 15 * 60; // 15 minutes
    uint256 constant MAX_WAITING_PERIOD = 5 days;

    //
    // EXTERNAL NON-VIEW
    //

    function initialize(
        string memory nameArg,
        string memory symbolArg,
        address priceFeedArg
    ) external initializer {
        __VirtualToken_init(nameArg, symbolArg);

        uint8 priceFeedDecimals = IPriceFeed(priceFeedArg).decimals();

        // invalid price feed decimals
        require(priceFeedDecimals <= decimals(), "BT_IPFD");

        _priceFeed = priceFeedArg;
        _priceFeedDecimals = priceFeedDecimals;
    }

    function pause() external onlyOwner {
        // BT_NO: Not open
        require(_status == IBaseToken.Status.Open, "BT_NO");
        _pausedIndexPrice = getIndexPrice(TWAP_INTERVAL_FOR_PAUSE);
        _status = IBaseToken.Status.Paused;
        _pausedTimestamp = _blockTimestamp();
        emit StatusUpdated(_status);
    }

    function close(uint256 closedPrice) external onlyOwner {
        // BT_NP: Not paused
        require(_status == IBaseToken.Status.Paused, "BT_NP");
        _close(closedPrice);
    }

    function close() external override {
        // BT_NP: Not paused
        require(_status == IBaseToken.Status.Paused, "BT_NP");
        // BT_WPNE: Waiting period not expired
        require(_blockTimestamp() > _pausedTimestamp + MAX_WAITING_PERIOD, "BT_WPNE");
        _close(_pausedIndexPrice);
    }

    function setPriceFeed(address priceFeedArg) external onlyOwner {
        // ChainlinkPriceFeed uses 8 decimals
        // BandPriceFeed uses 18 decimals
        uint8 priceFeedDecimals = IPriceFeed(priceFeedArg).decimals();
        // BT_IPFD: Invalid price feed decimals
        require(priceFeedDecimals <= decimals(), "BT_IPFD");

        _priceFeed = priceFeedArg;
        _priceFeedDecimals = priceFeedDecimals;

        emit PriceFeedChanged(_priceFeed);
    }

    //
    // INTERNAL NON-VIEW
    //

    function _close(uint256 closedPrice) internal {
        _status = IBaseToken.Status.Closed;
        _closedPrice = closedPrice;
        emit StatusUpdated(_status);
    }

    //
    // EXTERNAL VIEW
    //

    /// @inheritdoc IBaseToken
    function getPriceFeed() external view override returns (address) {
        return _priceFeed;
    }

    function isOpen() external view override returns (bool) {
        return _status == IBaseToken.Status.Open;
    }

    function isPaused() external view override returns (bool) {
        return _status == IBaseToken.Status.Paused;
    }

    function isClosed() external view override returns (bool) {
        return _status == IBaseToken.Status.Closed;
    }

    function getPausedTimestamp() external view override returns (uint256) {
        return _pausedTimestamp;
    }

    function getPausedIndexPrice() external view override returns (uint256) {
        return _pausedIndexPrice;
    }

    /// @inheritdoc IBaseToken
    function getClosedPrice() external view override returns (uint256) {
        // not closed
        require(_status == IBaseToken.Status.Closed, "BT_NC");
        return _closedPrice;
    }

    //
    // PUBLIC VIEW
    //

    /// @inheritdoc IIndexPrice
    /// @dev we overwrite the index price in BaseToken depending on the status
    ///      1. Open: the price is from the price feed
    ///      2. Paused or Closed: the price is twap when the token was paused
    function getIndexPrice(uint256 interval) public view override returns (uint256) {
        if (_status == IBaseToken.Status.Open) {
            return _formatDecimals(IPriceFeed(_priceFeed).getPrice(interval));
        }

        return _pausedIndexPrice;
    }

    //
    // INTERNAL VIEW
    //

    function _formatDecimals(uint256 _price) internal view returns (uint256) {
        return _price.mul(10**(decimals().sub(_priceFeedDecimals)));
    }
}
