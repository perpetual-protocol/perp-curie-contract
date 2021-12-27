// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;

import { SafeMathUpgradeable } from "@openzeppelin/contracts-upgradeable/math/SafeMathUpgradeable.sol";
import { IPriceFeed } from "@perp/perp-oracle-contract/contracts/interface/IPriceFeed.sol";
import { IIndexPrice } from "./interface/IIndexPrice.sol";
import { VirtualToken } from "./VirtualToken.sol";
import { BaseTokenStorageV2 } from "./storage/BaseTokenStorage.sol";
import { IBaseToken } from "./interface/IBaseToken.sol";
import { BlockContext } from "./base/BlockContext.sol";

// never inherit any new stateful contract. never change the orders of parent stateful contracts
contract BaseToken is IBaseToken, IIndexPrice, BlockContext, VirtualToken, BaseTokenStorageV2 {
    using SafeMathUpgradeable for uint256;
    using SafeMathUpgradeable for uint8;

    //
    // CONSTANT
    //

    uint256 constant MAX_WAITING_PERIOD = 7 days;

    //
    // EXTERNAL NON-VIEW
    //

    function initialize(
        string memory nameArg,
        string memory symbolArg,
        address priceFeedArg
    ) external initializer {
        __VirtualToken_init(nameArg, symbolArg);

        uint8 __priceFeedDecimals = IPriceFeed(priceFeedArg).decimals();
        // BT_IPFD: Invalid price feed decimals
        require(__priceFeedDecimals <= decimals(), "BT_IPFD");

        _priceFeed = priceFeedArg;
        _priceFeedDecimals = __priceFeedDecimals;
    }

    function pause(uint256 twInterval) external onlyOwner {
        // BT_NO: Not open
        require(_status == IBaseToken.Status.Open, "BT_NO");
        _endingIndexPrice = getIndexPrice(twInterval);
        _status = IBaseToken.Status.Paused;
        _endingTimestamp = _blockTimestamp();
        emit StatusUpdated(IBaseToken.Status.Paused);
    }

    function close(uint256 closedPrice) external onlyOwner {
        // BT_NP: Not paused
        require(_status == IBaseToken.Status.Paused, "BT_NP");
        _status = IBaseToken.Status.Closed;
        _closedPrice = closedPrice;
        emit StatusUpdated(IBaseToken.Status.Closed);
    }

    function close() external override {
        // BT_NP: Not paused
        require(_status == IBaseToken.Status.Paused, "BT_NP");
        // BT_WPNE: Waiting period not expired
        require(_blockTimestamp() > _endingTimestamp + MAX_WAITING_PERIOD, "BT_WPNE");
        _status = IBaseToken.Status.Closed;
        _closedPrice = _endingIndexPrice;
        emit StatusUpdated(IBaseToken.Status.Closed);
    }

    function setPriceFeed(address priceFeedArg) external override {
        // ChainlinkPriceFeed uses 8 decimals
        // BandPriceFeed uses 18 decimals
        uint8 __priceFeedDecimals = IPriceFeed(priceFeedArg).decimals();
        // BT_IPFD: Invalid price feed decimals
        require(__priceFeedDecimals <= decimals(), "BT_IPFD");

        _priceFeed = priceFeedArg;
        _priceFeedDecimals = __priceFeedDecimals;

        emit PriceFeedChanged(priceFeedArg);
    }

    //
    // EXTERNAL VIEW
    //

    /// @inheritdoc IBaseToken
    function getPriceFeed() external view override returns (address) {
        return _priceFeed;
    }

    function getStatus() external view override returns (IBaseToken.Status) {
        return _status;
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

    function getEndingTimestamp() external view override returns (uint256) {
        return _endingTimestamp;
    }

    function getEndingIndexPrice() external view override returns (uint256) {
        return _endingIndexPrice;
    }

    //
    // PUBLIC VIEW
    //

    /// @inheritdoc IIndexPrice
    function getIndexPrice(uint256 interval) public view override returns (uint256) {
        if (_status == IBaseToken.Status.Closed) {
            return _closedPrice;
        } else if (_status == IBaseToken.Status.Paused) {
            return _endingIndexPrice;
        } else {
            return _formatDecimals(IPriceFeed(_priceFeed).getPrice(interval));
        }
    }

    //
    // INTERNAL VIEW
    //

    function _formatDecimals(uint256 _price) internal view returns (uint256) {
        return _price.mul(10**(decimals().sub(_priceFeedDecimals)));
    }
}
