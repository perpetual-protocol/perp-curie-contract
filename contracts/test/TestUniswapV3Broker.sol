pragma solidity 0.7.6;
pragma abicoder v2;

import "../lib/UniswapV3Broker.sol";
import "../interface/IMintableERC20.sol";
import "@uniswap/v3-core/contracts/interfaces/callback/IUniswapV3MintCallback.sol";
import "@uniswap/v3-periphery/contracts/libraries/CallbackValidation.sol";
import "@uniswap/v3-periphery/contracts/libraries/PoolAddress.sol";
import "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";

contract TestUniswapV3Broker is IUniswapV3MintCallback {
    address private _factory;

    constructor(address factory) {
        _factory = factory;
    }

    /// @inheritdoc IUniswapV3MintCallback
    function uniswapV3MintCallback(
        uint256 amount0Owed,
        uint256 amount1Owed,
        bytes calldata data
    ) external override {
        // FIXME
        // MintCallbackData memory decoded = abi.decode(data, (MintCallbackData));
        // CallbackValidation.verifyCallback(_factory, decoded.poolKey);
        IUniswapV3Pool pool = IUniswapV3Pool(msg.sender);

        if (amount0Owed > 0) {
            IMintableERC20(pool.token0()).mint(address(this), amount0Owed);
            IMintableERC20(pool.token0()).transfer(msg.sender, amount0Owed);
        }
        if (amount1Owed > 0) {
            IMintableERC20(pool.token1()).mint(address(this), amount1Owed);
            IMintableERC20(pool.token1()).transfer(msg.sender, amount1Owed);
        }
    }

    function mint(UniswapV3Broker.MintParams calldata params)
        external
        returns (UniswapV3Broker.MintResponse memory response)
    {
        return UniswapV3Broker.mint(params);
    }
}
